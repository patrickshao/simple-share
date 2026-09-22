import type { SVGProps } from "react";

type IconName =
  | "arrow-up"
  | "check"
  | "copy"
  | "device"
  | "download"
  | "file"
  | "link"
  | "lock"
  | "receive"
  | "send"
  | "share"
  | "shield"
  | "x";

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    "arrow-up": <path d="m6 10 6-6 6 6M12 4v16" />,
    check: <path d="m5 12 4 4L19 6" />,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>,
    device: <><rect x="5" y="2.5" width="14" height="19" rx="3" /><path d="M10 18.5h4" /></>,
    download: <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14" />,
    file: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v5h5" /></>,
    link: <><path d="M9.5 14.5 14.5 9" /><path d="M7.5 17.5 5 20a4 4 0 0 1-5.5-5.5L4 10a4 4 0 0 1 5.5 0" transform="translate(2 -3)" /><path d="m14.5 6.5 2.5-2.5a4 4 0 1 1 5.5 5.5L18 14a4 4 0 0 1-5.5 0" transform="translate(-1 3)" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    receive: <path d="M12 3v14m0 0 6-6m-6 6-6-6M5 21h14" />,
    send: <><path d="m21 3-7.2 18-4.1-7.7L2 9.2z" /><path d="M9.7 13.3 21 3" /></>,
    share: <><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.5m-7.6 6.9 7.6 4.5" /></>,
    shield: <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Zm-3-10 2 2 4-5" />,
    x: <path d="m6 6 12 12M18 6 6 18" />,
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
