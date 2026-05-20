import { ChatJobAuthFetchProvider } from '@/components/ChatJobAuthFetchProvider';
import { ChatPanelModelOptionsPatch } from '@/components/ChatPanelModelOptionsPatch';

export default function ChatPage() {
  return (
    <ChatJobAuthFetchProvider>
      <ChatPanelModelOptionsPatch />
    </ChatJobAuthFetchProvider>
  );
}
