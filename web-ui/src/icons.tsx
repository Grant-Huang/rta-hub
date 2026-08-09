import type { ComponentType, SVGProps } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRotateCcw,
  ArrowUp,
  AtSign,
  AvatarProfile,
  Cabinet,
  ChatCompose,
  Check,
  ChevronLeft,
  FileDocument,
  PaperclipAttach,
  PlusComposer,
  RestoreUntrash,
  Settings,
  Trash,
  User,
  X,
} from "@openai/apps-sdk-ui/components/Icon";

export type SdkIconName =
  | "Archive"
  | "ArrowLeft"
  | "ArrowRotateCcw"
  | "ArrowUp"
  | "AtSign"
  | "AvatarProfile"
  | "Cabinet"
  | "ChatCompose"
  | "Check"
  | "ChevronLeft"
  | "FileDocument"
  | "PaperclipAttach"
  | "PlusComposer"
  | "RestoreUntrash"
  | "Settings"
  | "Trash"
  | "User"
  | "X";

type IconComp = ComponentType<SVGProps<SVGSVGElement>>;

/** 系统壳用到的 Apps SDK UI 图标子集（按需扩展）。 */
export const SDK_ICONS: Record<SdkIconName, IconComp> = {
  Archive,
  ArrowLeft,
  ArrowRotateCcw,
  ArrowUp,
  AtSign,
  AvatarProfile,
  Cabinet,
  ChatCompose,
  Check,
  ChevronLeft,
  FileDocument,
  PaperclipAttach,
  PlusComposer,
  RestoreUntrash,
  Settings,
  Trash,
  User,
  X,
};

export function isSdkIconName(name: string): name is SdkIconName {
  return Object.prototype.hasOwnProperty.call(SDK_ICONS, name);
}
