// A GUI program: no console window behind it in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    choiterm_desktop::run();
}
