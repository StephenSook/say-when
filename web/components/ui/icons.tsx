/**
 * Hand-drawn inline icons (docs/ui.md: small viewBox, 1.3 to 1.8 px stroke, round caps). Words come
 * first; an icon is always next to a word, never alone. Every icon is hidden from screen readers.
 */
import type { ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function Icon({ size = 12, viewBox = '0 0 12 12', strokeWidth = 1.6, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.8} {...props}>
      <path d="M2.5 6.2 5 8.5 9.5 3.5" />
    </Icon>
  );
}

export function HourglassIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 1.5h6M3 10.5h6M3.5 1.5 8.5 10.5M8.5 1.5 3.5 10.5" />
    </Icon>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.7} {...props}>
      <path d="M3.6 3.6 8.4 8.4M8.4 3.6 3.6 8.4" />
    </Icon>
  );
}

export function NoEntryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="6" r="4.4" />
      <path d="M3.6 6h4.8" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.8} {...props}>
      <path d="M4.5 3.2v5.6M7.5 3.2v5.6" />
    </Icon>
  );
}

export function HeadsetIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 16 16" strokeWidth={1.4} {...props}>
      <path d="M3 9.5V8a5 5 0 0 1 10 0v1.5" />
      <rect x="2" y="9" width="3" height="4.5" rx="1" />
      <rect x="11" y="9" width="3" height="4.5" rx="1" />
    </Icon>
  );
}

export function ReplayIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 16 16" strokeWidth={1.5} {...props}>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 2.5V5h-2.5" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 16 16" strokeWidth={1.5} {...props}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Icon>
  );
}
