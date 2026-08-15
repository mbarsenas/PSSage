import test from "node:test";
import assert from "node:assert/strict";
import { inspectPowerShellError } from "../src/tools.js";

test("classifies command not found", () => {
  const result = inspectPowerShellError(`
Get-Foo : The term 'Get-Foo' is not recognized as the name of a cmdlet, function, script file, or operable program.
CategoryInfo          : ObjectNotFound: (Get-Foo:String) [], CommandNotFoundException
FullyQualifiedErrorId : CommandNotFoundException
`);
  assert.equal(result.category, "CommandNotFound");
  assert.equal(result.fullyQualifiedErrorId, "CommandNotFoundException");
  assert.ok(result.clues.length > 0);
});

test("classifies authorization errors", () => {
  const result = inspectPowerShellError("Invoke-RestMethod: Response status code does not indicate success: 403 (Forbidden).");
  assert.equal(result.category, "Authorization");
});
