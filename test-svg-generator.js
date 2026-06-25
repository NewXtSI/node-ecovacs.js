import { generateMapSvg } from "./src/api2/mapVisualizerSvg.js";
import { writeFile } from "node:fs/promises";

// Mock mapInfo decoded data
const mockMapData = [
  ["1", "Wohnzimmer", "1;-3550,-24800;-3500,-24850;-3500,-24900;-3550,-24850"],
  ["2", "Küche", "2;-1500,8700;-1400,8750;-1450,8700"],
  ["3", "Schlafzimmer", "3;2000,5000;2100,5000;2100,5100;2000,5100"]
];

const mockArInfo = [
  ["1", "2", "1;-3600,-24850;-3525,-24925;-3450,-24875", "2;-3400,-24750;-3325,-24825;-3260,-24780"],
  ["2", "3", "145;-1550,8750;-1450,8825;-1375,8725"]
];

try {
  console.log("🚀 Generating SVG for mock map data...");
  const svg = generateMapSvg(mockMapData, { arInfo: mockArInfo });
  
  const filename = "test_map_visualization.svg";
  await writeFile(filename, svg, "utf8");
  
  console.log(`✅ SVG generated and saved to: ${filename}`);
  console.log(`📊 SVG size: ${svg.length} bytes`);
  console.log(`\n📄 First 500 chars of SVG:\n${svg.substring(0, 500)}...`);
} catch (err) {
  console.error("❌ Error:", err.message);
  process.exit(1);
}
