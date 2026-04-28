export interface UsbSerialConfig {
  port: string;
  baudRate: number;
}

export async function startUsbSerialAdapter(_cfg: UsbSerialConfig): Promise<() => Promise<void>> {
  throw new Error('USB serial adapter is not implemented in the MVP; use file-watch instead');
}
