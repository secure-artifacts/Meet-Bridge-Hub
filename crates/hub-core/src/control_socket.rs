use std::io;
use std::path::PathBuf;

use shared_proto::{BrokerCoreMessage, HealthPong};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const CONTROL_SOCKET_FILE: &str = "native-control.sock";

/// Per-user broker control endpoint. PCM is never carried over this socket.
pub fn control_socket_path() -> io::Result<PathBuf> {
    #[cfg(unix)]
    {
        // SAFETY: `geteuid` has no preconditions and only reads the current process UID.
        let uid = unsafe { libc::geteuid() };
        Ok(PathBuf::from("/tmp").join(format!("meet-bridge-hub-{uid}-{CONTROL_SOCKET_FILE}")))
    }
    #[cfg(windows)]
    {
        Ok(PathBuf::from(r"\\.\pipe\MeetBridgeHub-Control-v1"))
    }
    #[cfg(all(not(unix), not(windows)))]
    Err(io::Error::other(
        "named pipe endpoint is not implemented yet",
    ))
}

#[cfg(unix)]
pub fn prepare_control_socket_directory(path: &std::path::Path) -> io::Result<()> {
    if path.exists() {
        use std::os::unix::fs::FileTypeExt;
        if !std::fs::symlink_metadata(path)?.file_type().is_socket() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "control path is not a socket",
            ));
        }
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(unix)]
pub async fn serve_control_endpoint(
    path: PathBuf,
    core_instance_id: Uuid,
    hub: crate::service::HubService,
) -> io::Result<()> {
    prepare_control_socket_directory(&path)?;
    let listener = tokio::net::UnixListener::bind(&path)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    loop {
        let (mut stream, _) = listener.accept().await?;
        let connection_hub = hub.clone();
        tokio::spawn(async move {
            let _ = handle_control_connection(&mut stream, core_instance_id, connection_hub).await;
        });
    }
}

#[cfg(unix)]
async fn handle_control_connection(
    stream: &mut tokio::net::UnixStream,
    core_instance_id: Uuid,
    hub: crate::service::HubService,
) -> io::Result<()> {
    let request: BrokerCoreMessage = read_frame(stream).await?;
    let response = match request {
        BrokerCoreMessage::HealthPing(ping) => BrokerCoreMessage::HealthPong(HealthPong {
            request_id: ping.request_id,
            core_instance_id,
            core_epoch: "1".to_owned(),
        }),
        BrokerCoreMessage::ControlRequest(request) => hub.handle_control(request, core_instance_id),
        _ => return Ok(()),
    };
    write_frame(stream, &response).await
}

#[cfg(windows)]
const CONTROL_PIPE_NAME: &str = r"\\.\pipe\MeetBridgeHub-Control-v1";

#[cfg(windows)]
pub async fn serve_control_pipe(
    core_instance_id: Uuid,
    hub: crate::service::HubService,
) -> io::Result<()> {
    let mut server = create_control_pipe(true)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = create_control_pipe(false)?;
        let connection_hub = hub.clone();
        tokio::spawn(async move {
            let _ = handle_pipe_connection(connected, core_instance_id, connection_hub).await;
        });
    }
}

#[cfg(windows)]
fn create_control_pipe(
    first: bool,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use std::mem::size_of;
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::core::w;

    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // Owner-only DACL: a second Windows user cannot open the Hub control pipe.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w!("D:P(A;;GA;;;OW)"),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(io::Error::other)?;
    }
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let mut options = tokio::net::windows::named_pipe::ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true);
    let result = unsafe {
        options.create_with_security_attributes_raw(
            CONTROL_PIPE_NAME,
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
        )
    };
    unsafe {
        LocalFree(Some(HLOCAL(descriptor.0)));
    }
    result
}

#[cfg(windows)]
async fn handle_pipe_connection(
    mut stream: tokio::net::windows::named_pipe::NamedPipeServer,
    core_instance_id: Uuid,
    hub: crate::service::HubService,
) -> io::Result<()> {
    let request: BrokerCoreMessage = read_frame(&mut stream).await?;
    let response = match request {
        BrokerCoreMessage::HealthPing(ping) => BrokerCoreMessage::HealthPong(HealthPong {
            request_id: ping.request_id,
            core_instance_id,
            core_epoch: "1".to_owned(),
        }),
        BrokerCoreMessage::ControlRequest(request) => hub.handle_control(request, core_instance_id),
        _ => return Ok(()),
    };
    write_frame(&mut stream, &response).await
}

#[cfg(any(unix, windows))]
async fn read_frame<T: serde::de::DeserializeOwned, S: tokio::io::AsyncRead + Unpin>(
    stream: &mut S,
) -> io::Result<T> {
    let length = stream.read_u32_le().await?;
    if length > 1_048_576 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "control frame too large",
        ));
    }
    let mut payload = vec![0_u8; length as usize];
    stream.read_exact(&mut payload).await?;
    serde_json::from_slice(&payload).map_err(io::Error::other)
}

#[cfg(any(unix, windows))]
async fn write_frame<T: serde::Serialize, S: tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
    value: &T,
) -> io::Result<()> {
    let payload = serde_json::to_vec(value).map_err(io::Error::other)?;
    let length =
        u32::try_from(payload.len()).map_err(|_| io::Error::other("control frame too large"))?;
    stream.write_u32_le(length).await?;
    stream.write_all(&payload).await
}
