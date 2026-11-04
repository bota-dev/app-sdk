import { AppRegistry } from 'react-native';
import { registerGlobals } from '@livekit/react-native';
import App from './src/App';
registerGlobals();
AppRegistry.registerComponent('SpeechCompanion', () => App);
