!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.meetbridge.hub"
  Delete "$LOCALAPPDATA\Meet Bridge Hub\ChromeNativeMessaging\com.meetbridge.hub.json"
  RMDir "$LOCALAPPDATA\Meet Bridge Hub\ChromeNativeMessaging"
  RMDir "$LOCALAPPDATA\Meet Bridge Hub"
!macroend