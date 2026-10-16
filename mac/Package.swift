// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Ezrite",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Ezrite",
            path: "Sources/Ezrite",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "EzriteTests",
            dependencies: ["Ezrite"],
            path: "Tests/EzriteTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
