import { Goat } from "./src/goat.js";

async function main() {
  const goat = new Goat();

  // Register callbacks for changes
  goat.on("connected", () => {
    console.log("GOAT connected");
  });

  goat.on("position", (pos) => {
    console.log(`GOAT pos x: ${pos.x}, y: ${pos.y}, a: ${pos.a}`);
  });

  goat.on("battery", (battery) => {
    console.log(`GOAT battery  ${battery}%`);
  });

  goat.on("sleep", (sleep) => {
    console.log(`GOAT sleep  ${sleep}`);
  });

  goat.on("volume", (volume) => {
    console.log(
      `GOAT volume  ${volume.volume} / fall: ${volume.fallVolume} / search: ${volume.searchVolume}`
    );
  });

  goat.on("lifeSpan", (lifeSpan) => {
    const parts = Object.entries(lifeSpan).map(([k, v]) => `${k}: ${v.left}/${v.total}`).join(", ");
    console.log(`GOAT lifeSpan  ${parts}`);
  });

  goat.on("totalStats", (stats) => {
    console.log(`GOAT totalStats  area: ${stats.area}, time: ${stats.time}s, count: ${stats.count}`);
  });

  goat.on("netInfo", (net) => {
    console.log(`GOAT netInfo  ip: ${net.ip}, ssid: ${net.ssid}, rssi: ${net.rssi}`);
  });

  goat.on("mapState", (mapState) => {
    console.log(`GOAT mapState  state: ${mapState.state}, expandState: ${mapState.expandState}`);
  });

  goat.on("mowCommand", (cmd) => {
    console.log(`GOAT mowCommand  act: ${cmd.act}, type: ${cmd.type}, value: ${cmd.value}`);
    if (cmd.parsed) {
      const parsed = cmd.parsed;
      if (parsed.spotAreaIds?.length) {
        console.log(`GOAT mowCommand parsed  spotAreaIds: ${parsed.spotAreaIds.join(",")}`);
      }
      if (parsed.borderAreaIds?.length) {
        console.log(`GOAT mowCommand parsed  borderAreaIds: ${parsed.borderAreaIds.join(",")}`);
      }
      if (parsed.borderVirtualIds?.length) {
        console.log(`GOAT mowCommand parsed  borderVirtualIds: ${parsed.borderVirtualIds.join(",")}`);
      }
      if (parsed.unknownBorderTokens?.length) {
        console.log(`GOAT mowCommand parsed  unknownTokens: ${parsed.unknownBorderTokens.join(",")}`);
      }
    }
  });

  goat.on("mowInfo", (mowInfo) => {
    const motionState = mowInfo.cleanState?.motionState;
    const type = mowInfo.type ? mowInfo.type : "unknown";
    const detail = motionState ? `, motionState: ${motionState}` : "";
    console.log(`GOAT mowInfo  state: ${mowInfo.state}, type: ${type}, trigger: ${mowInfo.trigger}${detail}`);
  });

  goat.on("chargeState", (chargeState) => {
    console.log(`GOAT chargeState  isCharging: ${chargeState.isCharging}, mode: ${chargeState.mode}`);
  });

  goat.on("error", (errorCodes) => {
    console.log(`GOAT error  [${errorCodes.join(", ")}]`);
  });

  goat.on("geolocation", (geo) => {
    console.log(`GOAT geolocation  lat: ${geo.geoLocation.latitude}, lon: ${geo.geoLocation.longitude}`);
  });

  await goat.init();
  console.log("GOAT Initialized");

  await goat.connect();

  // Initial values
  const pos = goat.getPosition();
  if (pos) {
    console.log(`GOAT pos x: ${pos.x}, y: ${pos.y}, a: ${pos.a}`);
  }

  const battery = goat.getBattery();
  if (battery !== null) {
    console.log(`GOAT battery  ${battery}%`);
  }

  const sleep = goat.getSleep();
  if (sleep !== null) {
    console.log(`GOAT sleep  ${sleep}`);
  }

  const volume = goat.getVolume();
  if (volume) {
    console.log(`GOAT volume  ${volume.volume} / fall: ${volume.fallVolume} / search: ${volume.searchVolume}`);
  }

  const lifeSpan = goat.getLifeSpan();
  if (lifeSpan) {
    const parts = Object.entries(lifeSpan).map(([k, v]) => `${k}: ${v.left}/${v.total}`).join(", ");
    console.log(`GOAT lifeSpan  ${parts}`);
  }

  const totalStats = goat.getTotalStats();
  if (totalStats) {
    console.log(`GOAT totalStats  area: ${totalStats.area}, time: ${totalStats.time}s, count: ${totalStats.count}`);
  }

  const netInfo = goat.getNetInfo();
  if (netInfo) {
    console.log(`GOAT netInfo  ip: ${netInfo.ip}, ssid: ${netInfo.ssid}, rssi: ${netInfo.rssi}`);
  }

  const mapState = goat.getMapState();
  if (mapState) {
    console.log(`GOAT mapState  state: ${mapState.state}, expandState: ${mapState.expandState}`);
  }

  const mowInfo = goat.getMowInfo();
  if (mowInfo) {
    const motionState = mowInfo.cleanState?.motionState;
    const type = mowInfo.type ? mowInfo.type : "unknown";
    const detail = motionState ? `, motionState: ${motionState}` : "";
    console.log(`GOAT mowInfo  state: ${mowInfo.state}, type: ${type}, trigger: ${mowInfo.trigger}${detail}`);
  }

  const mowCommand = goat.getMowCommand();
  if (mowCommand) {
    console.log(`GOAT mowCommand  act: ${mowCommand.act}, type: ${mowCommand.type}, value: ${mowCommand.value}`);
  }

  const chargeState = goat.getChargeState();
  if (chargeState) {
    console.log(`GOAT chargeState  isCharging: ${chargeState.isCharging}, mode: ${chargeState.mode}`);
  }

  const errorCodes = goat.getError();
  if (errorCodes) {
    console.log(`GOAT error  [${errorCodes.join(", ")}]`);
  }

  const geolocation = goat.getGeolocation();
  if (geolocation) {
    console.log(`GOAT geolocation  lat: ${geolocation.geoLocation.latitude}, lon: ${geolocation.geoLocation.longitude}`);
  }

  goat.on("disconnected", () => {
    console.log("GOAT test completed");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("GOAT test error:", error);
  process.exit(1);
});
