// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DevboardTray",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "DevboardTray", targets: ["DevboardTray"]),
  ],
  targets: [
    .executableTarget(name: "DevboardTray"),
  ]
)
