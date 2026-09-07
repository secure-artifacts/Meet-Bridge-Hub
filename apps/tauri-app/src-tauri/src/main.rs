use hub_core::{HubConfig, HubService, HubStatus};
use tauri::State;

const NATIVE_HOST_NAME: &str = "com.meetbridge.hub";
const EXTENSION_ORIGIN: &str = "chrome-extension://ancoaojdjchmllenalcmmkgndahancgp/";

#[cfg(target_os = "macos")]
fn bundled_broker_path() -> Result<std::path::PathBuf, String> {
    let app_binary = std::env::current_exe().map_err(|error| error.to_string())?;
    let contents_dir = app_binary
        .parent()
        .ok_or_else(|| "Unable to locate the application bundle.".to_string())?
        .parent()
        .ok_or_else(|| "Unable to locate the application bundle contents.".to_string())?;
    let broker = contents_dir
        .join("Resources")
        .join("resources")
        .join("meet-bridge-native-broker");
    if !broker.is_file() {
        return Err(format!(
            "Bundled Native Broker is missing: {}",
            broker.display()
        ));
    }
    Ok(broker)
}

#[cfg(target_os = "macos")]
fn native_host_manifest_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "Unable to locate the current user home directory.".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
        .join(format!("{NATIVE_HOST_NAME}.json")))
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn native_host_registered() -> Result<bool, String> {
    let manifest_path = native_host_manifest_path()?;
    let Ok(contents) = std::fs::read(&manifest_path) else {
        return Ok(false);
    };
    let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&contents) else {
        return Ok(false);
    };
    let expected_broker = bundled_broker_path()?;
    let allowed_origins = manifest
        .get("allowed_origins")
        .and_then(serde_json::Value::as_array)
        .map(|origins| origins.len() == 1 && origins[0].as_str() == Some(EXTENSION_ORIGIN))
        .unwrap_or(false);
    Ok(
        manifest.get("name").and_then(serde_json::Value::as_str) == Some(NATIVE_HOST_NAME)
            && manifest.get("path").and_then(serde_json::Value::as_str) == expected_broker.to_str()
            && manifest.get("type").and_then(serde_json::Value::as_str) == Some("stdio")
            && allowed_origins,
    )
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn native_host_registered() -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn install_native_host() -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let broker = bundled_broker_path()?;
    let manifest_path = native_host_manifest_path()?;
    let host_dir = manifest_path
        .parent()
        .ok_or_else(|| "Unable to locate Chrome Native Messaging directory.".to_string())?;
    std::fs::create_dir_all(host_dir).map_err(|error| error.to_string())?;
    std::fs::set_permissions(host_dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;

    let manifest = serde_json::json!({
        "name": NATIVE_HOST_NAME,
        "description": "Meet Bridge Hub native broker",
        "path": broker,
        "type": "stdio",
        "allowed_origins": [EXTENSION_ORIGIN],
    });
    let temporary_path = manifest_path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(
        &temporary_path,
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    std::fs::set_permissions(&temporary_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    std::fs::rename(&temporary_path, &manifest_path).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn install_native_host() -> Result<(), String> {
    Err("Native Host installation has not been implemented for this platform.".to_string())
}

#[tauri::command]
fn hub_status(hub: State<'_, HubService>) -> HubStatus {
    hub.status()
}

#[tauri::command]
fn stop_all_bridging(hub: State<'_, HubService>) -> usize {
    hub.revoke_all_sessions()
}

#[tauri::command]
fn start_microphone(hub: State<'_, HubService>) -> Result<bool, String> {
    hub.start_microphone().map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_microphone(hub: State<'_, HubService>) -> bool {
    hub.stop_microphone()
}

fn main() {
    let hub = HubService::new(HubConfig::default());
    let runtime_hub = hub.clone();

    tauri::Builder::default()
        .manage(hub)
        .setup(move |_| {
            tauri::async_runtime::spawn(async move {
                if let Err(error) = runtime_hub.serve().await {
                    tracing::error!(%error, "hub audio service stopped");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hub_status,
            stop_all_bridging,
            start_microphone,
            stop_microphone,
            native_host_registered,
            install_native_host
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| panic!("failed to run Meet Bridge Hub: {error}"));
}
