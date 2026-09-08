use std::path::PathBuf;

use winreg::{RegKey, enums::HKEY_CURRENT_USER};

pub const NATIVE_HOST_NAME: &str = "com.meetbridge.hub";
pub const EXTENSION_ORIGIN: &str = "chrome-extension://ancoaojdjchmllenalcmmkgndahancgp/";

fn registry_path() -> String {
    format!("Software\\Google\\Chrome\\NativeMessagingHosts\\{NATIVE_HOST_NAME}")
}

fn manifest_path() -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
        "Unable to locate the current user's local application-data directory.".to_string()
    })?;
    Ok(PathBuf::from(local_app_data)
        .join("Meet Bridge Hub")
        .join("ChromeNativeMessaging")
        .join(format!("{NATIVE_HOST_NAME}.json")))
}

fn bundled_broker_path() -> Result<PathBuf, String> {
    let app_binary = std::env::current_exe().map_err(|error| error.to_string())?;
    let install_dir = app_binary
        .parent()
        .ok_or_else(|| "Unable to locate the application installation directory.".to_string())?;
    let broker = install_dir
        .join("resources")
        .join("meet-bridge-native-broker.exe");
    if !broker.is_file() {
        return Err(format!(
            "Bundled Native Broker is missing: {}",
            broker.display()
        ));
    }
    Ok(broker)
}

fn manifest_for(broker: &std::path::Path) -> serde_json::Value {
    serde_json::json!({
        "name": NATIVE_HOST_NAME,
        "description": "Meet Bridge Hub native broker",
        "path": broker,
        "type": "stdio",
        "allowed_origins": [EXTENSION_ORIGIN],
    })
}

pub fn is_registered() -> Result<bool, String> {
    let manifest_path = manifest_path()?;
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
    let chrome = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = chrome.open_subkey(registry_path()) else {
        return Ok(false);
    };
    let Ok(registered_manifest): Result<String, _> = key.get_value("") else {
        return Ok(false);
    };
    Ok(
        manifest.get("name").and_then(serde_json::Value::as_str) == Some(NATIVE_HOST_NAME)
            && manifest.get("path").and_then(serde_json::Value::as_str) == expected_broker.to_str()
            && manifest.get("type").and_then(serde_json::Value::as_str) == Some("stdio")
            && allowed_origins
            && registered_manifest == manifest_path.to_string_lossy(),
    )
}

pub fn install() -> Result<(), String> {
    let broker = bundled_broker_path()?;
    let manifest_path = manifest_path()?;
    let host_dir = manifest_path
        .parent()
        .ok_or_else(|| "Unable to locate the Chrome Native Messaging directory.".to_string())?;
    std::fs::create_dir_all(host_dir).map_err(|error| error.to_string())?;
    let temporary_path = manifest_path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(
        &temporary_path,
        serde_json::to_vec_pretty(&manifest_for(&broker)).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    std::fs::rename(&temporary_path, &manifest_path).map_err(|error| error.to_string())?;

    let chrome = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = chrome
        .create_subkey(registry_path())
        .map_err(|error| error.to_string())?;
    key.set_value("", &manifest_path.to_string_lossy().to_string())
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn uninstall() -> Result<bool, String> {
    let manifest_path = manifest_path()?;
    let mut removed = false;
    if manifest_path.is_file() {
        std::fs::remove_file(&manifest_path).map_err(|error| error.to_string())?;
        removed = true;
    }
    let chrome = RegKey::predef(HKEY_CURRENT_USER);
    match chrome.delete_subkey_all(registry_path()) {
        Ok(()) => removed = true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_allows_only_the_fixed_extension() {
        let manifest = manifest_for(std::path::Path::new(
            r"C:\Program Files\Meet Bridge Hub\resources\meet-bridge-native-broker.exe",
        ));
        assert_eq!(manifest["name"], NATIVE_HOST_NAME);
        assert_eq!(manifest["type"], "stdio");
        assert_eq!(
            manifest["allowed_origins"],
            serde_json::json!([EXTENSION_ORIGIN])
        );
    }
}
