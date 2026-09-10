#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

#[cfg(target_os = "macos")]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
#[cfg(target_os = "macos")]
static NATIVE_NOTIFICATIONS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static NOTIFICATION_CLICK: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(target_os = "macos")]
extern "C" {
    fn keep_init_notifications() -> bool;
    fn keep_play_attention_sound();
    fn keep_clipboard_has_image() -> bool;
    fn keep_send_notification(
        title: *const std::ffi::c_char,
        body: *const std::ffi::c_char,
        key: *const std::ffi::c_char,
    );
}

#[cfg(target_os = "macos")]
#[no_mangle]
extern "C" fn keep_notification_clicked(key: *const std::ffi::c_char) {
    use tauri::Emitter;
    if key.is_null() {
        return;
    }
    let key = unsafe { std::ffi::CStr::from_ptr(key) }
        .to_string_lossy()
        .into_owned();
    if let Ok(mut pending) = NOTIFICATION_CLICK.lock() {
        *pending = Some(key);
    }
    if let Some(app) = APP.get() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.emit("keep-notification-click", ());
        }
    }
}

#[tauri::command]
fn get_notification_click() -> Option<String> {
    NOTIFICATION_CLICK.lock().ok()?.clone()
}

#[tauri::command]
fn acknowledge_notification_click(key: String) {
    if let Ok(mut pending) = NOTIFICATION_CLICK.lock() {
        if pending.as_ref() == Some(&key) {
            *pending = None;
        }
    }
}

#[tauri::command]
fn send_notification(title: String, body: String, key: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if !NATIVE_NOTIFICATIONS.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("Native notifications require a bundled app".into());
        }
        let title = std::ffi::CString::new(title).map_err(|e| e.to_string())?;
        let body = std::ffi::CString::new(body).map_err(|e| e.to_string())?;
        let key = std::ffi::CString::new(key).map_err(|e| e.to_string())?;
        unsafe {
            keep_send_notification(title.as_ptr(), body.as_ptr(), key.as_ptr());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (title, body, key);
    Ok(())
}

#[tauri::command]
fn clipboard_has_image() -> bool {
    #[cfg(target_os = "macos")]
    unsafe { return keep_clipboard_has_image(); }
    #[cfg(not(target_os = "macos"))]
    false
}

#[tauri::command]
fn play_attention_sound() {
    #[cfg(target_os = "macos")]
    unsafe { keep_play_attention_sound(); }
}

#[tauri::command]
fn set_badge(window: tauri::Window, count: Option<i64>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window
            .set_badge_count(count.filter(|count| *count > 0))
            .map_err(|error| error.to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (window, count);

    Ok(())
}

fn main() {
    tauri::Builder::default()
        // Tauri supplies the default macOS application/edit menus when no custom menu is set.
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let _ = APP.set(app.handle().clone());
                NATIVE_NOTIFICATIONS.store(
                    unsafe { keep_init_notifications() },
                    std::sync::atomic::Ordering::Relaxed,
                );
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Keep the console subscribed while its window is closed, so
                // notifications and their session targets remain available.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_badge,
            clipboard_has_image,
            play_attention_sound,
            send_notification,
            get_notification_click,
            acknowledge_notification_click
        ])
        .build(tauri::generate_context!())
        .expect("error while building Keep desktop")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if has_visible_windows {
                    return;
                }

                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                } else if let Ok(window) = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Keep")
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .traffic_light_position(tauri::LogicalPosition::new(12.0, 14.0))
                .inner_size(1500.0, 950.0)
                .min_inner_size(900.0, 600.0)
                .build()
                {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
