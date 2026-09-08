use std::io;
#[cfg(unix)]
use std::path::PathBuf;

use shared_proto::{
    BrokerCoreMessage, ControlRequest, ControlResponse, HealthPing, HealthPong, NativeRequest,
    NativeResponse, ProfileId,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

#[cfg(unix)]
fn control_socket_path() -> PathBuf {
    let uid = unsafe { libc::geteuid() };
    PathBuf::from("/tmp").join(format!("meet-bridge-hub-{uid}-native-control.sock"))
}

#[cfg(unix)]
pub async fn probe_hub() -> Result<Uuid, CoreClientError> {
    let mut stream = tokio::net::UnixStream::connect(control_socket_path()).await?;
    let request_id = Uuid::new_v4();
    write_frame(
        &mut stream,
        &BrokerCoreMessage::HealthPing(HealthPing { request_id }),
    )
    .await?;
    let BrokerCoreMessage::HealthPong(HealthPong {
        request_id: response_id,
        core_instance_id,
        ..
    }) = read_frame(&mut stream).await?
    else {
        return Err(CoreClientError::UnexpectedResponse);
    };
    if response_id != request_id {
        return Err(CoreClientError::MismatchedResponse);
    }
    Ok(core_instance_id)
}

#[cfg(unix)]
pub async fn forward_control(
    broker_instance_id: Uuid,
    profile_id: ProfileId,
    message: NativeRequest,
) -> Result<NativeResponse, CoreClientError> {
    let mut stream = tokio::net::UnixStream::connect(control_socket_path()).await?;
    write_frame(
        &mut stream,
        &BrokerCoreMessage::ControlRequest(ControlRequest {
            broker_instance_id,
            profile_id,
            message,
        }),
    )
    .await?;
    let BrokerCoreMessage::ControlResponse(ControlResponse { message, .. }) =
        read_frame(&mut stream).await?
    else {
        return Err(CoreClientError::UnexpectedResponse);
    };
    Ok(message)
}

#[cfg(windows)]
const CONTROL_PIPE_NAME: &str = r"\\.\pipe\MeetBridgeHub-Control-v1";

#[cfg(windows)]
pub async fn probe_hub() -> Result<Uuid, CoreClientError> {
    let mut stream =
        tokio::net::windows::named_pipe::ClientOptions::new().open(CONTROL_PIPE_NAME)?;
    let request_id = Uuid::new_v4();
    write_frame(
        &mut stream,
        &BrokerCoreMessage::HealthPing(HealthPing { request_id }),
    )
    .await?;
    let BrokerCoreMessage::HealthPong(HealthPong {
        request_id: response_id,
        core_instance_id,
        ..
    }) = read_frame(&mut stream).await?
    else {
        return Err(CoreClientError::UnexpectedResponse);
    };
    if response_id != request_id {
        return Err(CoreClientError::MismatchedResponse);
    }
    Ok(core_instance_id)
}

#[cfg(windows)]
pub async fn forward_control(
    broker_instance_id: Uuid,
    profile_id: ProfileId,
    message: NativeRequest,
) -> Result<NativeResponse, CoreClientError> {
    let mut stream =
        tokio::net::windows::named_pipe::ClientOptions::new().open(CONTROL_PIPE_NAME)?;
    write_frame(
        &mut stream,
        &BrokerCoreMessage::ControlRequest(ControlRequest {
            broker_instance_id,
            profile_id,
            message,
        }),
    )
    .await?;
    let BrokerCoreMessage::ControlResponse(ControlResponse { message, .. }) =
        read_frame(&mut stream).await?
    else {
        return Err(CoreClientError::UnexpectedResponse);
    };
    Ok(message)
}

#[cfg(all(not(unix), not(windows)))]
pub async fn probe_hub() -> Result<Uuid, CoreClientError> {
    Err(CoreClientError::UnsupportedPlatform)
}

#[cfg(any(unix, windows))]
async fn read_frame<T: serde::de::DeserializeOwned, S: tokio::io::AsyncRead + Unpin>(
    stream: &mut S,
) -> Result<T, CoreClientError> {
    let length = stream.read_u32_le().await?;
    if length > 1_048_576 {
        return Err(CoreClientError::FrameTooLarge);
    }
    let mut payload = vec![0_u8; length as usize];
    stream.read_exact(&mut payload).await?;
    Ok(serde_json::from_slice(&payload)?)
}

#[cfg(any(unix, windows))]
async fn write_frame<T: serde::Serialize, S: tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
    value: &T,
) -> Result<(), CoreClientError> {
    let payload = serde_json::to_vec(value)?;
    let length = u32::try_from(payload.len()).map_err(|_| CoreClientError::FrameTooLarge)?;
    stream.write_u32_le(length).await?;
    stream.write_all(&payload).await?;
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum CoreClientError {
    #[error("control socket I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("control socket serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("control frame is too large")]
    FrameTooLarge,
    #[error("unexpected control response")]
    UnexpectedResponse,
    #[error("control response request ID mismatch")]
    MismatchedResponse,
    #[error("named pipe client is not implemented on this platform")]
    UnsupportedPlatform,
}
