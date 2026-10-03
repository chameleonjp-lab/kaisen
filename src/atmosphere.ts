import { OCEAN_GLSL } from './ocean';

/** Only shading has short ripples; vertex height remains the exact collision surface. */
export const seaVertex = `
uniform float uTime;
varying vec3 vWorld;
${OCEAN_GLSL}
void main(){
 vWorld=(modelMatrix*vec4(position,1.)).xyz;
 vWorld.y=oceanHeight(vWorld.xz,uTime);
 gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);
}`;

export const seaFragment = `
uniform float uTime;
varying vec3 vWorld;
${OCEAN_GLSL}
void main(){
 float d=length(cameraPosition-vWorld);
 vec2 p=vWorld.xz;
 vec2 gradient=oceanGradient(p,uTime);
 // Metre-scale ripples fade before they become sub-pixel glitter.
 float nearDetail=exp(-d*.00125);
 // A shared wind direction makes long, slightly broken crests instead of
 // crossing two equal ripples into a regular grid of oval bright patches.
 vec2 wind=vec2(.87,.493);
 float along=dot(p,wind), across=dot(p,vec2(-wind.y,wind.x));
 float phase=along*.19-uTime*.92+sin(across*.017+along*.006)*.65+sin(across*.047-uTime*.11)*.20;
 float swell=along*.083+across*.014-uTime*.66+sin(across*.025)*.4;
 float slope=(cos(phase)*.045+cos(swell)*.022)*nearDetail;
 vec3 n=normalize(vec3(-gradient.x+wind.x*slope,1.,-gradient.y+wind.y*slope));
 vec3 eye=normalize(cameraPosition-vWorld);
 vec3 sun=normalize(vec3(-.6,.65,-.35));
 float facing=max(0.,dot(n,eye));
 float fres=pow(1.-facing,3.);
 float reflected=max(0.,dot(reflect(-sun,n),eye));
 // A broad, restrained reflection path remains visible beyond individual ripples.
 float sunPath=pow(reflected,28.);
 float glint=pow(reflected,140.);
 vec3 water=mix(vec3(.023,.155,.197),vec3(.32,.52,.56),fres);
 float broad=sin(p.x*.017+p.y*.011-uTime*.31)*.55+sin(p.x*-.009+p.y*.023+uTime*.22)*.45;
 water+=vec3(.012,.032,.034)*broad*exp(-d*.00048);
 float cloud=sin(p.x*.0012+p.y*.0006+uTime*.008)*sin(p.y*.0018-p.x*.0004);
 water*=1.-.075*smoothstep(.1,.75,cloud);
 water+=vec3(.60,.48,.29)*sunPath*.20+vec3(.92,.80,.55)*glint*.26;
 float crest=smoothstep(.90,.995,sin(phase));
 float crestBreak=.35+.65*smoothstep(-.4,.7,sin(across*.022+sin(along*.005)*.5));
 water+=vec3(.018,.032,.028)*crest*crestBreak*nearDetail;
 // Haze begins beyond combat distances, leaving near silhouettes and tracers clear.
 water=mix(water,vec3(.57,.72,.75),smoothstep(3600.,18500.,d)*.93);
 gl_FragColor=vec4(water,1.);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;

export const skyVertex = `
varying vec3 vPosition;
void main(){
 vPosition=position;
 gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
}`;

export const skyFragment = `
varying vec3 vPosition;
void main(){
 vec3 p=normalize(vPosition);
 float h=max(0.,p.y);
 vec3 sun=normalize(vec3(-.6,.65,-.35));
 float sunFacing=max(0.,dot(p,sun));
 vec3 c=mix(vec3(.66,.78,.80),vec3(.16,.35,.52),pow(h,.48));
 float horizon=exp(-h*20.);
 c=mix(c,vec3(.73,.80,.79),horizon*.26);
 c+=vec3(.29,.21,.105)*pow(sunFacing,28.);
 c+=vec3(.53,.41,.21)*pow(sunFacing,520.);
 // Wide cloud banks use a few bounded harmonics, without textures or screen fog.
 float cloud=sin(p.x*20.+p.z*8.)*.48+sin(p.z*31.-p.x*10.)*.32+sin(p.x*49.+p.z*39.)*.20;
 float band=smoothstep(.08,.20,h)*(1.-smoothstep(.39,.56,h));
 float coverage=smoothstep(.25,.72,cloud)*band;
 c=mix(c,vec3(.80,.84,.83),coverage*.43);
 gl_FragColor=vec4(c,1.);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;
