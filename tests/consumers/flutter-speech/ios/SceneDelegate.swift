import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {
    override func sceneDidEnterBackground(_ scene: UIScene) {
        (UIApplication.shared.delegate as? AppDelegate)?.speechBridge?.leave()
        (UIApplication.shared.delegate as? AppDelegate)?.recordingBridge?.leave()
        super.sceneDidEnterBackground(scene)
    }
    override func sceneDidDisconnect(_ scene: UIScene) {
        (UIApplication.shared.delegate as? AppDelegate)?.speechBridge?.leave()
        (UIApplication.shared.delegate as? AppDelegate)?.recordingBridge?.leave()
        super.sceneDidDisconnect(scene)
    }
}
