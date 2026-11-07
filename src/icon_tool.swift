// SPDX-License-Identifier: MPL-2.0
import AppKit
import Foundation
import UniformTypeIdentifiers

let args = CommandLine.arguments
func fail(_ message: String) -> Never {
    fputs(message + "\n", stderr)
    exit(1)
}
func emit(_ value: Any) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    } catch { fail("JSON encoding failed: \(error)") }
}
func target(_ path: String, mutation: Bool = false) -> String {
    let url = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    guard url.pathExtension == "app", FileManager.default.fileExists(atPath: url.path + "/Contents/Info.plist") else {
        fail("Expected an existing .app bundle")
    }
    if mutation && ["/System/", "/usr/", "/Library/Apple/System/"].contains(where: url.path.hasPrefix) {
        fail("Protected system app: artwork may be previewed, but cannot be applied here")
    }
    return url.path
}
func image(_ path: String) -> NSImage {
    guard let value = NSImage(contentsOfFile: path), value.isValid else { fail("Cannot decode image") }
    return value
}
func export(_ value: NSImage, _ path: String) {
    validateReadback(value)
    guard let tiff = value.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let data = rep.representation(using: .png, properties: [:]) else { fail("PNG encoding failed") }
    do { try data.write(to: URL(fileURLWithPath: path), options: .atomic) }
    catch { fail("Cannot save PNG: \(error)") }
}
func pixels(_ value: NSImage) -> [UInt8] {
    // Normalize the same PNG representation used for the durable backup.
    // NSWorkspace images can otherwise choose a different ICNS rendition at 64px.
    guard let tiff = value.tiffRepresentation,
          let sourceRep = NSBitmapImageRep(data: tiff),
          let data = sourceRep.representation(using: .png, properties: [:]),
          let normalized = NSImage(data: data) else { fail("Cannot normalize comparison image") }
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 256, bitsPerPixel: 32)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: 64, height: 64).fill()
    normalized.draw(in: NSRect(x: 0, y: 0, width: 64, height: 64), from: .zero,
               operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return Array(UnsafeBufferPointer(start: rep.bitmapData!, count: 64 * 64 * 4))
}
func validateReadback(_ value: NSImage) {
    let data = pixels(value)
    // The observed denied-service image had only two tiny corner patches (<1% coverage).
    // All collection icons have solid tiles; refuse such an image before saving a baseline.
    let visible = stride(from: 3, to: data.count, by: 4).filter { data[$0] > 0 }.count
    guard Double(visible) / 4096 >= 0.01 else {
        fail("Cannot trust nearly blank icon readback; no valid application icon was returned")
    }
    for type in [UTType.folder, UTType.applicationBundle] {
        if data == pixels(NSWorkspace.shared.icon(for: type)) {
            fail("Cannot trust generic folder/application fallback as an application icon")
        }
    }
}
switch args.count > 1 ? args[1] : "" {
case "resolve":
    guard args.count == 3 else { fail("resolve BUNDLE_ID") }
    // Launch Services also registers build candidates, staging Apps and old copies.
    // Bulk/default discovery must not mutate those merely because they were launched once.
    let installedRoots = ["/Applications/", NSHomeDirectory() + "/Applications/",
                          "/System/Applications/", "/System/Library/CoreServices/"]
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: args[2]),
       installedRoots.contains(where: url.path.hasPrefix),
       FileManager.default.fileExists(atPath: url.path + "/Contents/Info.plist") {
        emit(["path": url.path])
        break
    }
    // Updates can leave Launch Services unable to resolve an installed App.
    // Inspect only direct App bundles in the two standard install directories.
    var matches = Set<String>()
    for directory in ["/Applications", NSHomeDirectory() + "/Applications"] {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: directory) else { continue }
        for entry in entries where entry.hasSuffix(".app") {
            let path = URL(fileURLWithPath: directory + "/" + entry).resolvingSymlinksInPath().path
            guard let info = NSDictionary(contentsOfFile: path + "/Contents/Info.plist"),
                  info["CFBundleIdentifier"] as? String == args[2] else { continue }
            matches.insert(path)
        }
    }
    if matches.count > 1 { fail("Multiple installed Apps share this bundle ID; specify --app /path/Name.app") }
    guard let path = matches.first else { fail("App not found; specify --app /path/Name.app") }
    emit(["path": path])
case "inspect":
    guard args.count == 3 else { fail("inspect APP") }
    let path = target(args[2])
    guard let info = NSDictionary(contentsOfFile: path + "/Contents/Info.plist"),
          let id = info["CFBundleIdentifier"] as? String else { fail("Missing bundle identity") }
    // Discovery/status also guard already-default skips; a clear flag alone is insufficient.
    validateReadback(NSWorkspace.shared.icon(forFile: path))
    let fileId = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier as? NSObject
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: id).filter { app in
        guard let url = app.bundleURL else { return false }
        let otherId = try? url.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier as? NSObject
        if let fileId, let otherId { return fileId.isEqual(otherId) }
        return url.resolvingSymlinksInPath().standardizedFileURL.path == path
    }.map { Int($0.processIdentifier) }.sorted()
    emit(["path": path, "bundleId": id,
          "runningPids": running,
          "name": (info["CFBundleDisplayName"] ?? info["CFBundleName"] ?? URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent) as Any,
          "version": (info["CFBundleShortVersionString"] ?? info["CFBundleVersion"] ?? "unknown") as Any])
case "export":
    guard args.count == 4 else { fail("export APP OUTPUT") }
    export(NSWorkspace.shared.icon(forFile: target(args[2])), args[3])
    emit(["saved": args[3]])
case "apply":
    guard args.count == 4 else { fail("apply APP IMAGE") }
    let path = target(args[2], mutation: true)
    guard NSWorkspace.shared.setIcon(image(args[3]), forFile: path, options: []) else { fail("setIcon returned false") }
    emit(["applied": true])
case "clear":
    guard args.count == 3 else { fail("clear APP") }
    guard NSWorkspace.shared.setIcon(nil, forFile: target(args[2], mutation: true), options: []) else { fail("setIcon clear returned false") }
    emit(["cleared": true])
case "compare":
    guard args.count == 4 else { fail("compare APP IMAGE") }
    let current = NSWorkspace.shared.icon(forFile: target(args[2]))
    validateReadback(current)
    let lhs = pixels(current)
    let rhs = pixels(image(args[3]))
    let mean = zip(lhs, rhs).reduce(0.0) { $0 + Double(abs(Int($1.0) - Int($1.1))) } / Double(lhs.count * 255)
    emit(["normalizedMeanError": mean, "matches": mean <= 0.015])
case "image-info":
    guard args.count == 3,
          let data = try? Data(contentsOf: URL(fileURLWithPath: args[2])),
          let rep = NSBitmapImageRep(data: data) else { fail("image-info IMAGE") }
    guard rep.pixelsWide == rep.pixelsHigh, rep.pixelsWide <= 4096 else { fail("Image must be square and at most 4096px") }
    validateReadback(image(args[2]))
    let corners = [(0, 0), (rep.pixelsWide - 1, 0), (0, rep.pixelsHigh - 1), (rep.pixelsWide - 1, rep.pixelsHigh - 1)]
    let transparent = rep.hasAlpha && corners.allSatisfy { point in
        guard let color = rep.colorAt(x: point.0, y: point.1) else { return false }
        return color.alphaComponent < 0.01
    }
    emit(["width": rep.pixelsWide, "height": rep.pixelsHigh, "hasAlpha": rep.hasAlpha, "transparentCorners": transparent])
default:
    fail("resolve | inspect | export | apply | clear | compare | image-info")
}
