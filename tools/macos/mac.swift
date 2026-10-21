// The macOS runner's hands and eyes for tools/macos/check.sh (ATA-230): the
// player window's number and bounds, the app in front, and synthetic clicks,
// drags and keys. CI only: never run it on someone's own desktop.
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
let num = { (i: Int) in CGFloat(Double(args[i])!) }

func window() -> (Int, CGRect)? {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  // The bare binary, or the .app.
  let names = ["nts-desktop-wmp", "NTS Radio Bootleg Media Player"]
  for w in list where names.contains(w[kCGWindowOwnerName as String] as? String ?? "") && w[kCGWindowLayer as String] as? Int == 0 {
    if let b = w[kCGWindowBounds as String], let rect = CGRect(dictionaryRepresentation: b as! CFDictionary) {
      return (w[kCGWindowNumber as String] as! Int, rect)
    }
  }
  return nil
}

func mouse(_ type: CGEventType, _ x: CGFloat, _ y: CGFloat) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(30_000)
}

switch args.first {
case "window":
  guard let (id, r) = window() else { print("none"); exit(1) }
  print(id, Int(r.minX), Int(r.minY), Int(r.width), Int(r.height))
case "front":
  print(NSWorkspace.shared.frontmostApplication?.localizedName ?? "none")
case "click":
  // The app looks at the pointer 20 times a second (lib.rs, watch_pointer).
  mouse(.mouseMoved, num(1), num(2))
  usleep(200_000)
  mouse(.leftMouseDown, num(1), num(2))
  mouse(.leftMouseUp, num(1), num(2))
case "drag":
  let (x1, y1, x2, y2) = (num(1), num(2), num(3), num(4))
  mouse(.mouseMoved, x1, y1)
  usleep(200_000)
  mouse(.leftMouseDown, x1, y1)
  for i in 1...20 {
    let t = CGFloat(i) / 20
    mouse(.leftMouseDragged, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
  }
  mouse(.leftMouseUp, x2, y2)
case "key":
  // A key code with Command: 12 is Q, 4 is H, 13 is W.
  let code = CGKeyCode(Int(args[1])!)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    e?.flags = .maskCommand
    e?.post(tap: .cghidEventTap)
    usleep(30_000)
  }
default:
  print("usage: mac window | front | click x y | drag x1 y1 x2 y2 | key code")
  exit(2)
}
