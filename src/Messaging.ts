import fs from "fs";
import path from "path";

const PREFIX = "[ClaudeGates]";
const NOTIFICATION_FILE = ".pipeline-notifications";

export class Messaging
{
  public static fmt(emoji: string, text: string,): string
  {
    return `${PREFIX} ${emoji} ${text}`;
  }

  public static block(emoji: string, text: string,): void
  {
    const msg = Messaging.fmt(emoji, text,);
    process.stdout.write(JSON.stringify({ decision: "block", reason: msg, },),);
  }

  public static info(emoji: string, text: string,): void
  {
    const msg = Messaging.fmt(emoji, text,);
    process.stdout.write(JSON.stringify({ systemMessage: msg, },),);
  }

  public static notify(sessionDir: string, emoji: string, text: string,): void
  {
    const msg = Messaging.fmt(emoji, text,);
    const filePath = path.join(sessionDir, NOTIFICATION_FILE,);
    try
    {
      fs.appendFileSync(filePath, msg + "\n", "utf-8",);
    }
    catch
    {
    }
  }

  public static drainNotifications(sessionDir: string,): string | null
  {
    const filePath = path.join(sessionDir, NOTIFICATION_FILE,);
    try
    {
      if (!fs.existsSync(filePath,))
      {
        return null;
      }
      const content = fs.readFileSync(filePath, "utf-8",).trim();
      fs.unlinkSync(filePath,);
      return content || null;
    }
    catch
    {
      return null;
    }
  }

  public static log(emoji: string, text: string,): void
  {
    process.stderr.write(Messaging.fmt(emoji, text,) + "\n",);
  }

  public static readonly NOTIFICATION_FILE = NOTIFICATION_FILE;
}
