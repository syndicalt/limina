import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const producer=new URL("./build-furniture-review.ts",import.meta.url),source=await readFile(producer,"utf8");
const start=source.indexOf("export function furnitureReviewCameraLayout"),end=source.indexOf("\n\nconst root",start);
assert.ok(start>=0&&end>start,"camera layout helper must remain independently testable");
const snippet=source.slice(start,end).replace("export function","function"),compiled=new Bun.Transpiler({loader:"ts"}).transformSync(snippet);
const furnitureReviewCameraLayout=new Function(`${compiled}\nreturn furnitureReviewCameraLayout;`)();
const close=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-12,`${message}: expected ${expected}, received ${actual}`);
const point=(actual,expected,message)=>actual.forEach((value,index)=>close(value,expected[index],`${message}[${index}]`));

test("storage review cameras honor canonical local -X front and -Z right side",()=>{
  const layout=furnitureReviewCameraLayout([-.2,0,-.5],[.2,1.8,.5],[-1,0,0]);
  assert.deepEqual(layout.frontAxis,[-1,0,0]);
  assert.deepEqual(layout.rightAxis,[-0,0,-1]);
  close(layout.frontageM,1,"storage frontage");
  point(layout.front,[-2.81,1.08,0],"front from -X");
  point(layout.back,[2.81,1.08,0],"back from +X");
  point(layout.rightSide,[0,1.08,-3.11],"right side from -Z");
});

test("storage oblique and overlay views remain front-right and bind the full frontage axis",()=>{
  const layout=furnitureReviewCameraLayout([-.2,0,-.5],[.2,1.8,.5],[-1,0,0]);
  for(const [id,position] of [["three-quarter",layout.threeQuarter],["joinery",layout.joinery],["overlay",layout.overlay]]){
    assert.ok(position[0]<-.2,`${id} must remain in front of the -X facade`);
    assert.ok(position[2]<-.5,`${id} must remain on the object's -Z right side`);
  }
  close(layout.frontageM,1,"oblique layout frontage");
  point(layout.joineryTarget,[0,.9,-.18],"joinery target uses eighteen percent of the 1m frontage");
});

test("chair and table review cameras preserve the legacy local -Z convention",()=>{
  const min=[-.7,0,-.4],max=[.7,.78,.4],layout=furnitureReviewCameraLayout(min,max),radius=1.4*1.45,eye=.39+.078;
  assert.deepEqual(layout.frontAxis,[0,0,-1]);
  assert.deepEqual(layout.rightAxis,[1,0,0]);
  close(layout.frontageM,1.4,"legacy frontage");
  point(layout.front,[0,eye,min[2]-radius],"legacy front");
  point(layout.rightSide,[max[0]+radius,eye,0],"legacy right side");
  point(layout.back,[0,eye,max[2]+radius],"legacy back");
  point(layout.threeQuarter,[max[0]+radius*.75,eye+.78*.18,min[2]-radius*.75],"legacy three-quarter");
  point(layout.joineryTarget,[1.4*.18,.39,0],"legacy joinery target");
});

test("authority generation selects the validated storage canonical front without role sniffing",()=>{
  assert.match(source,/furnitureReviewCameraLayout\(min,max,validatedContract\.storage\?\.canonicalFront\)/);
  assert.doesNotMatch(source,/role\.(?:includes|match)\([^\n]*storage/);
});
