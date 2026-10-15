import {validPlacement,validStyleValue,type ControlPlacement} from './control-appearance.ts'

export const SCENE_STYLE_PROPERTIES=['color','background-color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration-line','white-space'] as const
export type SceneStyle=Readonly<Partial<Record<typeof SCENE_STYLE_PROPERTIES[number],string>>>
export interface VectorShape {readonly tag:'path'|'circle'|'rect'|'line'|'polyline'|'polygon'|'ellipse';readonly attrs:Readonly<Record<string,string>>}
export interface ControlIcon {readonly viewBox:string;readonly shapes:readonly VectorShape[]}
export interface SceneItem {readonly key:string;readonly text:string;readonly placement:ControlPlacement;readonly style:number;readonly icon?:ControlIcon}
export interface ControlScene {readonly items:readonly SceneItem[];readonly styles:readonly SceneStyle[];readonly displayOnly:boolean}
const geometry:Record<VectorShape['tag'],readonly string[]>={path:['d'],circle:['cx','cy','r'],rect:['x','y','width','height','rx','ry'],line:['x1','y1','x2','y2'],
  polyline:['points'],polygon:['points'],ellipse:['cx','cy','rx','ry']}
const paint=['fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','opacity']
export function validIcon(value:unknown):value is ControlIcon {
  if(!value || typeof value!=='object' || Array.isArray(value))return false
  const icon=value as ControlIcon
  if(!Object.keys(icon).every(key=>['viewBox','shapes'].includes(key)) || typeof icon.viewBox!=='string' || icon.viewBox.length>100)return false
  const box=icon.viewBox.trim().split(/[\s,]+/).map(Number)
  if(box.length!==4 || !box.every(number=>Number.isFinite(number)&&Math.abs(number)<=4096) || box[2]!<=0 || box[3]!<=0)return false
  if(!Array.isArray(icon.shapes) || !icon.shapes.length || icon.shapes.length>24)return false
  return icon.shapes.every((shape:VectorShape)=>{
    if(!shape || !Object.keys(shape).every(key=>['tag','attrs'].includes(key)) || !Object.hasOwn(geometry,shape.tag)
      || !shape.attrs || typeof shape.attrs!=='object' || Array.isArray(shape.attrs))return false
    const entries=Object.entries(shape.attrs)
    return entries.length>0 && entries.every(([key,text])=>{
      if(typeof text!=='string' || !text.length || text.length>1024 || ![...geometry[shape.tag],...paint].includes(key))return false
      if(key==='d')return /^[MmZzLlHhVvCcSsQqTtAaEe\d\s.,+\-]+$/.test(text)
      if(key==='points')return /^[\d\s.,+\-]+$/.test(text)
      if(key==='fill' || key==='stroke')return text.length<=160 && validStyleValue(text)
      if(key==='stroke-linecap')return ['butt','round','square'].includes(text)
      if(key==='stroke-linejoin')return ['miter','round','bevel'].includes(text)
      if(key==='fill-rule')return ['nonzero','evenodd'].includes(text)
      if(key==='opacity')return /^\d*\.?\d+$/.test(text) && Number(text)>=0 && Number(text)<=1
      return /^-?\d+(?:\.\d+)?(?:px)?$/.test(text) && Math.abs(Number.parseFloat(text))<=4096
    })
  }) && new TextEncoder().encode(JSON.stringify(icon)).byteLength<=2400
}
export function validScene(value:unknown):value is ControlScene {
  if(!value || typeof value!=='object' || Array.isArray(value))return false
  const scene=value as ControlScene
  return Object.keys(scene).every(key=>['items','styles','displayOnly'].includes(key)) && typeof scene.displayOnly==='boolean'
    && Array.isArray(scene.styles) && scene.styles.length>0 && scene.styles.length<=24
    && scene.styles.every(style=>style && typeof style==='object' && !Array.isArray(style)
      && Object.entries(style).every(([key,text])=>SCENE_STYLE_PROPERTIES.includes(key as typeof SCENE_STYLE_PROPERTIES[number]) && validStyleValue(text)))
    && Array.isArray(scene.items) && scene.items.length>0 && scene.items.length<=24 && new Set(scene.items.map(item=>item?.key)).size===scene.items.length
    && scene.items.every(item=>item && Object.keys(item).every(key=>['key','text','placement','style','icon'].includes(key))
      && /^v(?:[0-9]|1[0-9]|2[0-3])$/.test(item.key) && typeof item.text==='string' && item.text.length<=512
      && (item.text.trim().length>0 || item.icon!==undefined) && validPlacement(item.placement)
      && Number.isInteger(item.style) && item.style>=0 && item.style<scene.styles.length && (item.icon===undefined || validIcon(item.icon)))
    && new TextEncoder().encode(JSON.stringify(scene)).byteLength<=6000
}
