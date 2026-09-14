import { CameraIcon, VideoIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { BottomSheet } from '../components/BottomSheet';
import { Button } from '../components/ui';
import { registerIcons } from '../lib/icons';
import type { CapturePreference } from './capture-intents';

registerIcons(CameraIcon, VideoIcon);

/**
 * Photos or video, for one area.
 *
 * Asked the first time the camera is opened on an area of an occupied visit,
 * and again only when the technician asks to change it -- see
 * `asksCaptureChoice`. The camera's big button takes the answer and the other
 * capture stays on the small one, so neither answer takes anything away.
 *
 * The same two buttons, in the same order, as the question it replaces, which
 * was asked once for the whole inspection when it was started. Photographs are
 * the common case on an occupied visit, so they are the primary answer.
 */
export function CaptureChoiceSheet({
  areaName,
  current,
  opensCamera,
  onChoose,
  onClose,
  visible,
}: {
  areaName: string;
  /** The answer this area already has, when the sheet is changing it. */
  current: CapturePreference | undefined;
  /** Whether answering goes on to open the camera, which the hints say. */
  opensCamera: boolean;
  onChoose: (mode: CapturePreference) => void;
  onClose: () => void;
  visible: boolean;
}) {
  return (
    <BottomSheet accessibilityRole="alert" animationType="fade" onClose={onClose} visible={visible}>
      <Text className="text-xl font-bold text-foreground">Photos or video for {areaName}?</Text>
      <Text className="mt-2 text-sm leading-5 text-muted-foreground">
        {current
          ? `${current === 'PHOTO' ? 'Photos are' : 'Video is'} on the camera's big button here now. The other stays one tap away.`
          : "The camera's big button takes whichever you choose, for this area only. The other stays one tap away."}
      </Text>
      <View className="mt-5 gap-3">
        <Button
          accessibilityHint={
            opensCamera
              ? 'Opens the camera with the photo button as the big button'
              : 'Makes the photo button the big button for this area'
          }
          icon={<CameraIcon size={18} className="text-primary-foreground" />}
          label="Photos"
          onPress={() => onChoose('PHOTO')}
        />
        <Button
          accessibilityHint={
            opensCamera
              ? 'Opens the camera with recording as the big button'
              : 'Makes recording the big button for this area'
          }
          icon={<VideoIcon size={18} className="text-foreground" />}
          label="Video walkthrough"
          onPress={() => onChoose('VIDEO')}
          variant="secondary"
        />
      </View>
    </BottomSheet>
  );
}
