// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CodexCommanderMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "CodexCommanderMenuBar", targets: ["MenuBarApp"]),
        .executable(name: "MenuBarCoreTests", targets: ["MenuBarCoreTests"]),
        .executable(name: "MenuBarUITests", targets: ["MenuBarUITests"]),
        .executable(name: "UIProbe", targets: ["UIProbe"]),
        .executable(name: "IconProbe", targets: ["IconProbe"]),
    ],
    dependencies: [
        // Sparkle 2.9.6; immutable revision also pins its binary artifact checksum.
        .package(url: "https://github.com/sparkle-project/Sparkle", revision: "ac2def288cbff5cfc7df3ffef6abdf45b72bcb0a"),
    ],
    targets: [
        .target(name: "MenuBarCore", path: "Sources/MenuBarCore"),
        // AppKit views live in a library so both the app and the visual-QA probe can
        // build the same surface. An executable target cannot be imported.
        .target(name: "MenuBarUI", dependencies: ["MenuBarCore", .product(name: "Sparkle", package: "Sparkle")], path: "Sources/MenuBarUI"),
        .executableTarget(
            name: "MenuBarApp",
            dependencies: ["MenuBarCore", "MenuBarUI"],
            path: "Sources/MenuBarApp"
        ),
        // An executable rather than a .testTarget: Xcode Command Line Tools ships
        // neither a usable XCTest module nor the swift-testing runtime, so a test bundle
        // cannot run without a full Xcode install. See Sources/MenuBarCoreTests/Harness.swift.
        .executableTarget(
            name: "MenuBarCoreTests",
            dependencies: ["MenuBarCore"],
            path: "Sources/MenuBarCoreTests"
        ),
        // UI-layer tests need AppKit and an NSApplication, so they are a separate
        // executable from the dependency-free core suite.
        .executableTarget(
            name: "MenuBarUITests",
            dependencies: ["MenuBarCore", "MenuBarUI"],
            path: "Sources/MenuBarUITests"
        ),
        .executableTarget(name: "UIProbe", dependencies: ["MenuBarCore", "MenuBarUI"], path: "Sources/UIProbe"),
        .executableTarget(name: "IconProbe", dependencies: ["MenuBarCore", "MenuBarUI"], path: "Sources/IconProbe"),
    ],
    swiftLanguageVersions: [.v5]
)
