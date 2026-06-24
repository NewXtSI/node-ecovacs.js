export class Api2Device {
  constructor(rawDevice) {
    this.rawDevice = rawDevice || {};
  }

  get isConnected() {
    return Number(this.rawDevice.status) === 1;
  }

  get id() {
    return this.rawDevice.did || null;
  }

  get name() {
    const baseName = String(
      this.rawDevice.deviceName || this.rawDevice.name || this.id || "Unknown Device"
    ).trim();
    const nickname = this.nickName;

    if (nickname) {
      return `${baseName} (${nickname})`;
    }

    return baseName;
  }

  get nickName() {
    const nick = this.rawDevice.nick;
    if (typeof nick !== "string") {
      return null;
    }

    const trimmed = nick.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  get className() {
    return this.rawDevice.class || null;
  }

  get productCategory() {
    return this.rawDevice.product_category || null;
  }
}
