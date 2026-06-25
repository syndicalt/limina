// Source-map verification: an uncaught error here should surface a stack trace
// whose frames reference throw.ts at these line numbers, not generated JS.

function inner(): never {
  throw new Error("intentional failure for source-map check");
}

function outer(): void {
  inner();
}

outer();
