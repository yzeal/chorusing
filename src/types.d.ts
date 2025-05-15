// Define custom extensions to the Window interface
interface Window {
  eruda?: {
    init: (options?: object) => void;
    get: (name: string) => unknown;
    $: (selector: string) => HTMLElement | null;
  };
  exportLogs?: () => void;
} 