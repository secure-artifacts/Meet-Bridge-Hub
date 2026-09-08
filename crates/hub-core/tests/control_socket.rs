#![allow(clippy::unwrap_used)]

use meet_bridge_hub_core::control_socket_path;

#[test]
fn control_socket_is_named_without_profile_or_web_data() {
    let path = control_socket_path().unwrap();
    #[cfg(unix)]
    assert!(
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with("-native-control.sock"))
    );
    #[cfg(windows)]
    assert_eq!(path.to_string_lossy(), r"\\.\pipe\MeetBridgeHub-Control-v1");
    assert!(
        !path
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("chrome")
    );
    assert!(
        !path
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("profile")
    );
}
