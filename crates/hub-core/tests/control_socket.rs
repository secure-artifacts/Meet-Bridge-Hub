#![allow(clippy::unwrap_used, clippy::expect_used)]

use meet_bridge_hub_core::control_socket_path;

#[test]
fn control_socket_is_named_without_profile_or_web_data() {
    let path = control_socket_path().unwrap();
    assert!(
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with("-native-control.sock"))
    );
    assert!(!path.to_string_lossy().contains("chrome"));
}
