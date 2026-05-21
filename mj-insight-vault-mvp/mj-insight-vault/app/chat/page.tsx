import { ChatLastReportLink } from '@/components/ChatLastReportLink';
import { ChatPanelModelOptionsPatch } from '@/components/ChatPanelModelOptionsPatch';

export default function ChatPage() {
  return (
    <div className="space-y-4">
      <ChatLastReportLink />
      <ChatPanelModelOptionsPatch />
    </div>
  );
}
