import {expect} from 'vitest';

export type Schema=Record<string,unknown>;
/** Strict Structured Outputs contract: every object node is closed and requires every one of its properties. Returns the object paths it checked. */
export function validate(schema:Schema,path='#',objects:string[]=[]):string[]{
  const type=schema.type;
  if(type==='object'||(Array.isArray(type)&&type.includes('object'))){
    expect(schema.additionalProperties,path).toBe(false);expect(schema.properties,path).toBeTypeOf('object');
    const properties=schema.properties as Record<string,Schema>;
    expect([...(schema.required as string[]??[])].sort(),path).toEqual(Object.keys(properties).sort());objects.push(path);
    for(const [key,child] of Object.entries(properties))validate(child,`${path}/properties/${key}`,objects);
  }
  expect(schema.patternProperties,path).toBeUndefined();
  if(schema.items!==undefined)validate(schema.items as Schema,`${path}/items`,objects);
  for(const keyword of ['anyOf','oneOf','allOf'])for(const [i,branch] of ((schema[keyword] as Schema[]|undefined)??[]).entries())validate(branch,`${path}/${keyword}/${i}`,objects);
  for(const keyword of ['$defs','definitions'])for(const [name,child] of Object.entries((schema[keyword] as Record<string,Schema>|undefined)??{}))validate(child,`${path}/${keyword}/${name}`,objects);
  return objects;
}
