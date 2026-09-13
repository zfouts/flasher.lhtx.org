/**
 * Web Bluetooth transport for companion firmware.
 *
 * MeshCore exposes a Nordic UART Service. Unlike USB serial, BLE frames are
 * not length-prefixed: each notification *is* one companion payload, so this
 * transport presents the same sendPayload/takeFrame/clearFrames interface as
 * MeshPort with no framing layer in between.
 *
 * Repeaters and room servers do not advertise over BLE, so this path is
 * companion-only by construction.
 */

const SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const CHAR_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // we write here
const CHAR_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // radio notifies here

export class BleTransport {
  constructor(device) {
    this.device = device;
    this.rx = null;
    this.tx = null;
    this.frames = [];
    this.writeChain = Promise.resolve();
    this.onDisconnect = () => {};
  }

  static supported() {
    return typeof navigator !== 'undefined'
      && !!navigator.bluetooth
      && typeof navigator.bluetooth.requestDevice === 'function';
  }

  static async request() {
    if (!BleTransport.supported()) {
      throw new Error('This browser has no Web Bluetooth support. Use Chrome, Edge or Opera on desktop or Android.');
    }
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    return new BleTransport(device);
  }

  async open() {
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect());

    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    this.rx = await service.getCharacteristic(CHAR_RX);
    this.tx = await service.getCharacteristic(CHAR_TX);

    await this.tx.startNotifications();
    this.tx.addEventListener('characteristicvaluechanged', (event) => {
      this.frames.push(new Uint8Array(event.target.value.buffer));
    });
  }

  async close() {
    try { this.device.gatt?.disconnect(); } catch { /* already gone */ }
  }

  /**
   * GATT allows one operation at a time, so writes are serialised. Without
   * this, back-to-back commands fail with "GATT operation already in progress".
   */
  async sendPayload(bytes) {
    this.writeChain = this.writeChain.then(() => this.rx.writeValue(bytes)).catch(() => {});
    return this.writeChain;
  }

  takeFrame() {
    return this.frames.shift() ?? null;
  }

  clearFrames() {
    this.frames = [];
  }
}
