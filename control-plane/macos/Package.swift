// swift-tools-version: 6.1

import PackageDescription

let package = Package(
  name: "KeenTerm",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "KeenTerm", targets: ["KeenTerm"]),
  ],
  dependencies: [
    .package(url: "https://github.com/Lakr233/libghostty-spm.git", from: "1.2.0"),
  ],
  targets: [
    .executableTarget(
      name: "KeenTerm",
      dependencies: [
        .product(name: "GhosttyTerminal", package: "libghostty-spm"),
      ]
    ),
  ]
)
