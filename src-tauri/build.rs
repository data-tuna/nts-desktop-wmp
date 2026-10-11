fn main() {
    // An app manifest makes Tauri check the ACL for our own commands too, so
    // a webview no capability names (the skin webview) cannot call them. Without
    // it, any page Tauri counts as local may call every app command.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "skin_send",
            "list_skins",
            "choose_skin",
            "open_link",
            "now_playing",
            "credit",
            "credit_size",
            "open_credit",
        ]),
    ))
    .expect("failed to run tauri-build");
}
