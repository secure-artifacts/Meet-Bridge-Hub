pub mod core_client;
pub mod native_message;

pub use native_message::{
    MAX_NATIVE_MESSAGE_BYTES, NativeMessageError, read_message, write_message,
};
