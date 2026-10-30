// The desktop app's entry (src/lib.rs is the app, shared with Android and iOS).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sagebrush_app_lib::run()
}
