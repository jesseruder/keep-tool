fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/notifications.m")
            .file("src/clipboard.m")
            .flag("-fobjc-arc")
            .compile("keep_notifications");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rerun-if-changed=src/notifications.m");
        println!("cargo:rerun-if-changed=src/clipboard.m");
    }
    // The console is a remote page (http://localhost:7777), and Tauri rejects app
    // commands from remote origins unless the ACL knows them, so generate
    // allow-set-badge / deny-set-badge and grant the former in capabilities/main.json.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "set_badge",
            "clipboard_has_image",
            "play_attention_sound",
            "send_notification",
            "get_notification_click",
            "acknowledge_notification_click",
        ]),
    ))
    .expect("failed to run tauri-build");
}
