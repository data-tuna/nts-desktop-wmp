//! What the app itself plays, for the visualisation during an NTS Pick
//! (ATA-199). A pick plays in SoundCloud's widget, a cross-origin frame whose
//! audio never reaches our Web Audio graph. Windows' process loopback hands
//! us what our process tree plays, WebView2's audio process included. The
//! samples stay in memory: nothing is recorded or sent anywhere.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Samples kept: as many as the trusted page's analyser reads (fftSize).
pub const LEN: usize = 8192;

struct State {
    /// The newest mono samples, oldest first.
    samples: Vec<f32>,
    /// When the trusted page last asked for them.
    asked: Option<Instant>,
    running: bool,
    /// Process loopback is not there (Windows before 10 2004): stop asking.
    failed: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    samples: Vec::new(),
    asked: None,
    running: false,
    failed: false,
});

/// The newest `LEN` samples at `rate` Hz; silence until the capture has some,
/// and none at all when it cannot run. The first call starts the capture, and
/// it stops itself a second after the last call.
pub fn latest(rate: u32) -> Vec<f32> {
    let mut state = STATE.lock().unwrap();
    if state.failed {
        return Vec::new();
    }
    state.asked = Some(Instant::now());
    if !state.running {
        state.running = true;
        state.samples = vec![0.0; LEN];
        std::thread::spawn(move || {
            // Opening fails for good where Windows has no process loopback.
            let result = match open(rate) {
                Ok(stream) => run(stream),
                Err(error) => {
                    STATE.lock().unwrap().failed = true;
                    Err(error)
                }
            };
            if let Err(error) = result {
                eprintln!("process loopback: {error}");
            }
            STATE.lock().unwrap().running = false;
        });
    }
    state.samples.clone()
}

type Stream = (
    wasapi::AudioClient,
    wasapi::AudioCaptureClient,
    wasapi::Handle,
);

fn open(rate: u32) -> Result<Stream, Box<dyn std::error::Error>> {
    use wasapi::*;
    initialize_mta().ok()?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, rate as usize, 2, None);
    // The whole tree: WebView2 plays from a process of its own under ours.
    let mut client = AudioClient::new_application_loopback_client(std::process::id(), true)?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };
    client.initialize_client(&format, &Direction::Capture, &mode)?;
    let event = client.set_get_eventhandle()?;
    let packets = client.get_audiocaptureclient()?;
    client.start_stream()?;
    Ok((client, packets, event))
}

/// Reads until nobody has asked for a second.
fn run((client, packets, event): Stream) -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = VecDeque::new();
    while STATE
        .lock()
        .unwrap()
        .asked
        .is_some_and(|t| t.elapsed() < Duration::from_secs(1))
    {
        // No event comes while the app plays nothing.
        if event.wait_for_event(100).is_err() {
            continue;
        }
        while packets.get_next_packet_size()?.unwrap_or(0) > 0 {
            let start = bytes.len();
            // A silent packet's data is to be ignored, but wasapi copies it anyway.
            if packets.read_from_device_to_deque(&mut bytes)?.flags.silent {
                bytes.range_mut(start..).for_each(|b| *b = 0);
            }
        }
        push(&mut STATE.lock().unwrap().samples, bytes.make_contiguous());
        bytes.clear();
    }
    client.stop_stream()?;
    Ok(())
}

/// Appends interleaved stereo f32 frames to `ring` as mono, keeping the newest `LEN`.
fn push(ring: &mut Vec<f32>, stereo: &[u8]) {
    let f = |b: &[u8]| f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    ring.extend(stereo.chunks_exact(8).map(|b| (f(b) + f(&b[4..])) / 2.0));
    let extra = ring.len().saturating_sub(LEN);
    ring.drain(..extra);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_keeps_the_newest_frames_as_mono() {
        let mut ring = vec![0.0; LEN];
        let stereo: Vec<u8> = [1.0f32, 3.0, -1.0, -0.5]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        push(&mut ring, &stereo);
        assert_eq!(ring.len(), LEN);
        assert_eq!(&ring[LEN - 2..], &[2.0, -0.75]);
        // A frame cut short is dropped, not read past.
        push(&mut ring, &stereo[..12]);
        assert_eq!(ring.len(), LEN);
        assert_eq!(ring[LEN - 1], 2.0);
    }
}
