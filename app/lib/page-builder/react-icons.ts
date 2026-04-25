// React Icons integration — renders react-icons components to SVG strings
// for use in the page builder canvas (which uses raw HTML, not React)

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// Curated popular icons from Lucide (react-icons/lu)
// Organized by category for the picker
export const REACT_ICON_CATEGORIES: Record<string, string[]> = {
  Arrows: [
    "LuArrowRight", "LuArrowLeft", "LuArrowUp", "LuArrowDown",
    "LuArrowUpRight", "LuArrowDownLeft", "LuArrowRightLeft", "LuArrowUpDown",
    "LuChevronRight", "LuChevronLeft", "LuChevronUp", "LuChevronDown",
    "LuChevronsRight", "LuChevronsLeft", "LuChevronsUp", "LuChevronsDown",
    "LuCornerDownRight", "LuCornerUpLeft", "LuMoveRight", "LuExternalLink",
  ],
  Actions: [
    "LuCheck", "LuX", "LuPlus", "LuMinus",
    "LuSearch", "LuFilter", "LuRefreshCw", "LuRotateCw",
    "LuCopy", "LuClipboard", "LuDownload", "LuUpload",
    "LuShare", "LuShare2", "LuSend", "LuSave",
    "LuTrash", "LuTrash2", "LuEdit", "LuPen",
    "LuMaximize", "LuMinimize", "LuExpand", "LuShrink",
  ],
  Communication: [
    "LuMail", "LuMailOpen", "LuPhone", "LuPhoneCall",
    "LuMessageSquare", "LuMessageCircle", "LuInbox", "LuSend",
    "LuBell", "LuBellRing", "LuMegaphone", "LuAtSign",
  ],
  Media: [
    "LuPlay", "LuPause", "LuSquare", "LuSkipForward",
    "LuSkipBack", "LuVolume2", "LuVolumeX", "LuMusic",
    "LuImage", "LuCamera", "LuVideo", "LuFilm",
    "LuMic", "LuHeadphones", "LuRadio", "LuTv",
  ],
  Users: [
    "LuUser", "LuUsers", "LuUserPlus", "LuUserMinus",
    "LuUserCheck", "LuUserX", "LuCircleUser", "LuContact",
  ],
  Files: [
    "LuFile", "LuFileText", "LuFilePlus", "LuFileEdit",
    "LuFolder", "LuFolderOpen", "LuFolderPlus", "LuArchive",
    "LuPaperclip", "LuLink", "LuLink2", "LuUnlink",
  ],
  UI: [
    "LuHome", "LuMenu", "LuSettings", "LuSliders",
    "LuGrid", "LuList", "LuLayout", "LuSidebar",
    "LuPanelLeft", "LuPanelRight", "LuLayers", "LuSquareStack",
    "LuMoreHorizontal", "LuMoreVertical", "LuGripVertical", "LuGripHorizontal",
  ],
  Commerce: [
    "LuShoppingCart", "LuShoppingBag", "LuCreditCard", "LuWallet",
    "LuReceipt", "LuTag", "LuTags", "LuPercent",
    "LuDollarSign", "LuBadgeDollarSign", "LuStore", "LuPackage",
  ],
  Status: [
    "LuCircleCheck", "LuCircleX", "LuCircleAlert", "LuTriangleAlert",
    "LuInfo", "LuHelpCircle", "LuAlertCircle", "LuShieldCheck",
    "LuShield", "LuBan", "LuLock", "LuUnlock",
    "LuEye", "LuEyeOff", "LuThumbsUp", "LuThumbsDown",
  ],
  Nature: [
    "LuStar", "LuHeart", "LuFlame", "LuZap",
    "LuSun", "LuMoon", "LuCloud", "LuCloudRain",
    "LuDroplet", "LuLeaf", "LuFlower", "LuTrees",
    "LuMountain", "LuWaves", "LuWind", "LuSnowflake",
  ],
  Tech: [
    "LuMonitor", "LuLaptop", "LuSmartphone", "LuTablet",
    "LuCode", "LuTerminal", "LuDatabase", "LuServer",
    "LuCloud", "LuWifi", "LuBluetooth", "LuCpu",
    "LuHardDrive", "LuGlobe", "LuRocket", "LuBug",
    "LuGitBranch", "LuGitCommit", "LuGitPullRequest", "LuGithub",
  ],
  Travel: [
    "LuMapPin", "LuMap", "LuCompass", "LuNavigation",
    "LuCar", "LuTrain", "LuPlane", "LuShip",
    "LuBuilding", "LuBuilding2", "LuHotel", "LuLandmark",
  ],
  Time: [
    "LuClock", "LuTimer", "LuAlarmClock", "LuCalendar",
    "LuCalendarDays", "LuCalendarCheck", "LuCalendarPlus", "LuHistory",
  ],
  Charts: [
    "LuBarChart", "LuBarChart2", "LuBarChart3", "LuLineChart",
    "LuPieChart", "LuTrendingUp", "LuTrendingDown", "LuActivity",
  ],
  Social: [
    "LuGithub", "LuTwitter", "LuYoutube", "LuLinkedin",
    "LuFacebook", "LuInstagram", "LuTwitch", "LuDiscord" as string,
  ],
};

// Flatten all icon names for search
export const ALL_REACT_ICONS: string[] = Object.values(REACT_ICON_CATEGORIES).flat();

/**
 * Dynamically import a Lucide icon and render it to an SVG string.
 */
export async function renderReactIconToSvg(
  iconName: string,
  size: number = 24
): Promise<string> {
  try {
    const mod = await import("react-icons/lu");
    const IconComponent = (mod as Record<string, React.ComponentType<{ size?: number }>>)[iconName];
    if (!IconComponent) return "";
    const svg = renderToStaticMarkup(createElement(IconComponent, { size }));
    return svg;
  } catch {
    return "";
  }
}

/**
 * Get display name from icon component name.
 * LuArrowRight → arrow-right
 */
export function iconDisplayName(name: string): string {
  return name
    .replace(/^Lu/, "")
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
}
