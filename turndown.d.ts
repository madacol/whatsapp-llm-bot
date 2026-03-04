declare module "turndown" {
  class TurndownService {
    constructor(options?: { headingStyle?: string; [key: string]: unknown });
    turndown(input: string): string;
  }
  export default TurndownService;
}
