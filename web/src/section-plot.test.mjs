import test from 'node:test';
import assert from 'node:assert/strict';
import {fitContours, snapContour, buildContourGraph, oppositeContour} from './section-plot.ts';

test('combined contours fill the viewport around their shared bounds', () => {
  const segments = [
    {a:[-5,-1],b:[-3,1]},
    {a:[3,-1],b:[5,1]},
  ];
  const view = fitContours(segments, 20);
  assert.deepEqual(view.pan, [0,0]);
  assert.ok(view.radius > 5 && view.radius < 6, `radius ${view.radius}`);
  const shifted = fitContours(segments.map(segment => ({a:[segment.a[0]+10,segment.a[1]],b:[segment.b[0]+10,segment.b[1]]})),20);
  assert.deepEqual(shifted.pan,[10,0]);
  assert.equal(shifted.radius, view.radius);
});

test('measurement anchor snaps to the closest contour within screen tolerance', () => {
  const contours = [{a:[0,0],b:[10,0]},{a:[0,4],b:[10,4]}];
  assert.deepEqual(snapContour([5,3.7], contours,.5), {point:[5,4],index:1});
  assert.deepEqual(snapContour([5,2], contours,.5), {point:[5,2],index:-1});
  assert.deepEqual(snapContour([-1,.1], contours,1.1), {point:[0,0],index:0});
});

test('opposite distance crosses a thin wall but rejects nearby segments of the same contour', () => {
  const wall = [];
  for (let x=0;x<10;x++) wall.push({a:[x,0],b:[x+1,0]});
  for (let x=0;x<10;x++) wall.push({a:[x,.6],b:[x+1,.6]});
  const graph = buildContourGraph(wall);
  const hit = oppositeContour(graph,[5,0],4);
  assert.ok(hit);
  assert.ok(Math.abs(hit.distance-.6)<1e-9);
  assert.deepEqual(hit.point,[5,.6]);
  assert.equal(oppositeContour(graph,[5,2],-1),null,'free placement has no opposite surface');
  assert.equal(oppositeContour(buildContourGraph(wall.slice(0,10)),[5,0],4),null,'one straight contour has no opposite wall');
});

test('opposite distance spans selected Meshes only when the gap is local to the picked contour', () => {
  const source = Array.from({length:10},(_,x)=>({a:[x,0],b:[x+1,0]}));
  const near = Array.from({length:10},(_,x)=>({a:[x,3],b:[x+1,3]}));
  const remote = Array.from({length:10},(_,x)=>({a:[x,20],b:[x+1,20]}));
  const selected = buildContourGraph([...source,...near,...remote]);
  assert.equal(oppositeContour(selected,[5,0],4)?.distance,3,'another selected Mesh can define a local gap');
  const distant = buildContourGraph([...source,...remote]);
  assert.equal(oppositeContour(distant,[5,0],4),null,'a scattered Mesh does not become a false opposite');
  assert.equal(oppositeContour(buildContourGraph(source),[5,0],4),null,'only supplied contours participate');
});

test('a single round contour does not report a long chord as wall thickness', () => {
  const steps = 96, radius = 10;
  const circle = Array.from({length:steps},(_,index) => {
    const point = (angle) => [Math.cos(angle)*radius,Math.sin(angle)*radius];
    return {a:point(index*2*Math.PI/steps),b:point((index+1)*2*Math.PI/steps)};
  });
  assert.equal(oppositeContour(buildContourGraph(circle),[radius,0],0),null);
});
