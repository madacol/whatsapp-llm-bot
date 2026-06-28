import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderFileChangeContent } from "../whatsapp/outbound/file-change-content.js";

describe("WhatsApp file-change content", () => {
  it("renders brand-new file writes as code through the extracted module", () => {
    const content = renderFileChangeContent({
      kind: "file_change",
      path: "src/new-module.js",
      changeKind: "add",
      newText: "export const value = 1;\n",
      summary: "src/new-module.js",
    });

    assert.deepEqual(content, [{
      type: "code",
      code: "export const value = 1;\n",
      language: "javascript",
      caption: "*Add*  `src/new-module.js`",
    }]);
  });
});
