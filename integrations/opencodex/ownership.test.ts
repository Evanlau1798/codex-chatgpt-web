import {test,expect} from 'bun:test';
const {assertOwnership}=require('./manager.cjs');
test('allows the supported internal hub arrangement',()=>{
 expect(()=>assertOwnership({runtimeRole:'hub',hostname:'127.0.0.1',clientIntegrations:{codex:false},unauthenticatedLoopbackListener:{enabled:false}})).not.toThrow();
});
test.each([
 {runtimeRole:'standalone',hostname:'127.0.0.1',clientIntegrations:{codex:false}},
 {runtimeRole:'hub',hostname:'0.0.0.0',clientIntegrations:{codex:false}},
 {runtimeRole:'hub',hostname:'127.0.0.1',clientIntegrations:{codex:true}},
 {runtimeRole:'hub',hostname:'127.0.0.1',clientIntegrations:{codex:false},unauthenticatedLoopbackListener:{enabled:true}},
])('refuses native takeover or unintended exposure %#',config=>expect(()=>assertOwnership(config)).toThrow());
