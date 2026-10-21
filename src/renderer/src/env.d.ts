import type { OfficeApi } from "../../preload/api";

declare global {
  interface Window {
    office: OfficeApi;
  }
}
