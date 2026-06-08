var Ri=Object.defineProperty;var Ui=(i,e)=>{for(var t in e)Ri(i,t,{get:e[t],enumerable:!0})};import{BufferAttribute as So,Box3 as mi,FrontSide as pi}from"three";var Xt=0,vn=1,Tn=2,Vi=0,ki=1,Ee=2;var wn=Math.pow(2,-24),Gt=Symbol("SKIP_GENERATION");import{BufferAttribute as Oi}from"three";function De(i){return i.index?i.index.count:i.attributes.position.count}function j(i){return De(i)/3}function Fe(i,e=ArrayBuffer){return i>65535?new Uint32Array(new e(4*i)):new Uint16Array(new e(2*i))}function Bn(i,e){if(!i.index){let t=i.attributes.position.count,n=e.useSharedArrayBuffer?SharedArrayBuffer:ArrayBuffer,o=Fe(t,n);i.setIndex(new Oi(o,1));for(let r=0;r<t;r++)o[r]=r}}function Ne(i){let e=j(i),t=i.drawRange,n=t.start/3,o=(t.start+t.count)/3,r=Math.max(0,n),s=Math.min(e,o)-r;return[{offset:Math.floor(r),count:Math.floor(s)}]}function Ce(i){if(!i.groups||!i.groups.length)return Ne(i);let e=[],t=new Set,n=i.drawRange,o=n.start/3,r=(n.start+n.count)/3;for(let a of i.groups){let c=a.start/3,p=(a.start+a.count)/3;t.add(Math.max(o,c)),t.add(Math.min(r,p))}let s=Array.from(t.values()).sort((a,c)=>a-c);for(let a=0;a<s.length-1;a++){let c=s[a],p=s[a+1];e.push({offset:Math.floor(c),count:Math.floor(p-c)})}return e}function _n(i){if(i.groups.length===0)return!1;let e=j(i),t=Ce(i).sort((r,s)=>r.offset-s.offset),n=t[t.length-1];n.count=Math.min(e-n.offset,n.count);let o=0;return t.forEach(({count:r})=>o+=r),e!==o}function Yt(i,e,t,n,o){let r=1/0,s=1/0,a=1/0,c=-1/0,p=-1/0,f=-1/0,u=1/0,l=1/0,d=1/0,b=-1/0,g=-1/0,x=-1/0;for(let h=e*6,m=(e+t)*6;h<m;h+=6){let y=i[h+0],v=i[h+1],A=y-v,T=y+v;A<r&&(r=A),T>c&&(c=T),y<u&&(u=y),y>b&&(b=y);let w=i[h+2],_=i[h+3],B=w-_,P=w+_;B<s&&(s=B),P>p&&(p=P),w<l&&(l=w),w>g&&(g=w);let I=i[h+4],S=i[h+5],M=I-S,E=I+S;M<a&&(a=M),E>f&&(f=E),I<d&&(d=I),I>x&&(x=I)}n[0]=r,n[1]=s,n[2]=a,n[3]=c,n[4]=p,n[5]=f,o[0]=u,o[1]=l,o[2]=d,o[3]=b,o[4]=g,o[5]=x}function Sn(i,e=null,t=null,n=null){let o=i.attributes.position,r=i.index?i.index.array:null,s=j(i),a=o.normalized,c;e===null?(c=new Float32Array(s*6*4),t=0,n=s):(c=e,t=t||0,n=n||s);let p=o.array,f=o.offset||0,u=3;o.isInterleavedBufferAttribute&&(u=o.data.stride);let l=["getX","getY","getZ"];for(let d=t;d<t+n;d++){let b=d*3,g=d*6,x=b+0,h=b+1,m=b+2;r&&(x=r[x],h=r[h],m=r[m]),a||(x=x*u+f,h=h*u+f,m=m*u+f);for(let y=0;y<3;y++){let v,A,T;a?(v=o[l[y]](x),A=o[l[y]](h),T=o[l[y]](m)):(v=p[x+y],A=p[h+y],T=p[m+y]);let w=v;A<w&&(w=A),T<w&&(w=T);let _=v;A>_&&(_=A),T>_&&(_=T);let B=(_-w)/2,P=y*2;c[g+P+0]=w+B,c[g+P+1]=B+(Math.abs(w)+B)*wn}}return c}function D(i,e,t){return t.min.x=e[i],t.min.y=e[i+1],t.min.z=e[i+2],t.max.x=e[i+3],t.max.y=e[i+4],t.max.z=e[i+5],t}function Le(i){let e=-1,t=-1/0;for(let n=0;n<3;n++){let o=i[n+3]-i[n];o>t&&(t=o,e=n)}return e}function ze(i,e){e.set(i)}function Re(i,e,t){let n,o;for(let r=0;r<3;r++){let s=r+3;n=i[r],o=e[r],t[r]=n<o?n:o,n=i[s],o=e[s],t[s]=n>o?n:o}}function It(i,e,t){for(let n=0;n<3;n++){let o=e[i+2*n],r=e[i+2*n+1],s=o-r,a=o+r;s<t[n]&&(t[n]=s),a>t[n+3]&&(t[n+3]=a)}}function lt(i){let e=i[3]-i[0],t=i[4]-i[1],n=i[5]-i[2];return 2*(e*t+t*n+n*e)}var Z=32,Hi=(i,e)=>i.candidate-e.candidate,J=new Array(Z).fill().map(()=>({count:0,bounds:new Float32Array(6),rightCacheBounds:new Float32Array(6),leftCacheBounds:new Float32Array(6),candidate:0})),jt=new Float32Array(6);function In(i,e,t,n,o,r){let s=-1,a=0;if(r===0)s=Le(e),s!==-1&&(a=(e[s]+e[s+3])/2);else if(r===1)s=Le(i),s!==-1&&(a=qi(t,n,o,s));else if(r===2){let c=lt(i),p=1.25*o,f=n*6,u=(n+o)*6;for(let l=0;l<3;l++){let d=e[l],x=(e[l+3]-d)/Z;if(o<Z/4){let h=[...J];h.length=o;let m=0;for(let v=f;v<u;v+=6,m++){let A=h[m];A.candidate=t[v+2*l],A.count=0;let{bounds:T,leftCacheBounds:w,rightCacheBounds:_}=A;for(let B=0;B<3;B++)_[B]=1/0,_[B+3]=-1/0,w[B]=1/0,w[B+3]=-1/0,T[B]=1/0,T[B+3]=-1/0;It(v,t,T)}h.sort(Hi);let y=o;for(let v=0;v<y;v++){let A=h[v];for(;v+1<y&&h[v+1].candidate===A.candidate;)h.splice(v+1,1),y--}for(let v=f;v<u;v+=6){let A=t[v+2*l];for(let T=0;T<y;T++){let w=h[T];A>=w.candidate?It(v,t,w.rightCacheBounds):(It(v,t,w.leftCacheBounds),w.count++)}}for(let v=0;v<y;v++){let A=h[v],T=A.count,w=o-A.count,_=A.leftCacheBounds,B=A.rightCacheBounds,P=0;T!==0&&(P=lt(_)/c);let I=0;w!==0&&(I=lt(B)/c);let S=1+1.25*(P*T+I*w);S<p&&(s=l,p=S,a=A.candidate)}}else{for(let y=0;y<Z;y++){let v=J[y];v.count=0,v.candidate=d+x+y*x;let A=v.bounds;for(let T=0;T<3;T++)A[T]=1/0,A[T+3]=-1/0}for(let y=f;y<u;y+=6){let T=~~((t[y+2*l]-d)/x);T>=Z&&(T=Z-1);let w=J[T];w.count++,It(y,t,w.bounds)}let h=J[Z-1];ze(h.bounds,h.rightCacheBounds);for(let y=Z-2;y>=0;y--){let v=J[y],A=J[y+1];Re(v.bounds,A.rightCacheBounds,v.rightCacheBounds)}let m=0;for(let y=0;y<Z-1;y++){let v=J[y],A=v.count,T=v.bounds,_=J[y+1].rightCacheBounds;A!==0&&(m===0?ze(T,jt):Re(T,jt,jt)),m+=A;let B=0,P=0;m!==0&&(B=lt(jt)/c);let I=o-m;I!==0&&(P=lt(_)/c);let S=1+1.25*(B*m+P*I);S<p&&(s=l,p=S,a=v.candidate)}}}}else console.warn(`MeshBVH: Invalid build strategy value ${r} used.`);return{axis:s,pos:a}}function qi(i,e,t,n){let o=0;for(let r=e,s=e+t;r<s;r++)o+=i[r*6+n*2];return o/t}var ft=class{constructor(){this.boundingData=new Float32Array(6)}};function Mn(i,e,t,n,o,r){let s=n,a=n+o-1,c=r.pos,p=r.axis*2;for(;;){for(;s<=a&&t[s*6+p]<c;)s++;for(;s<=a&&t[a*6+p]>=c;)a--;if(s<a){for(let f=0;f<3;f++){let u=e[s*3+f];e[s*3+f]=e[a*3+f],e[a*3+f]=u}for(let f=0;f<6;f++){let u=t[s*6+f];t[s*6+f]=t[a*6+f],t[a*6+f]=u}s++,a--}else return s}}function En(i,e,t,n,o,r){let s=n,a=n+o-1,c=r.pos,p=r.axis*2;for(;;){for(;s<=a&&t[s*6+p]<c;)s++;for(;s<=a&&t[a*6+p]>=c;)a--;if(s<a){let f=i[s];i[s]=i[a],i[a]=f;for(let u=0;u<6;u++){let l=t[s*6+u];t[s*6+u]=t[a*6+u],t[a*6+u]=l}s++,a--}else return s}}function L(i,e){return e[i+15]===65535}function z(i,e){return e[i+6]}function R(i,e){return e[i+14]}function O(i){return i+8}function k(i,e){return e[i+6]}function ut(i,e){return e[i+7]}var Dn,Mt,Zt,Fn,Wi=Math.pow(2,32);function Kt(i){return"count"in i?1:1+Kt(i.left)+Kt(i.right)}function Nn(i,e,t){return Dn=new Float32Array(t),Mt=new Uint32Array(t),Zt=new Uint16Array(t),Fn=new Uint8Array(t),Ve(i,e)}function Ve(i,e){let t=i/4,n=i/2,o="count"in e,r=e.boundingData;for(let s=0;s<6;s++)Dn[t+s]=r[s];if(o)if(e.buffer){let s=e.buffer;Fn.set(new Uint8Array(s),i);for(let a=i,c=i+s.byteLength;a<c;a+=32){let p=a/2;L(p,Zt)||(Mt[a/4+6]+=t)}return i+s.byteLength}else{let s=e.offset,a=e.count;return Mt[t+6]=s,Zt[n+14]=a,Zt[n+15]=65535,i+32}else{let s=e.left,a=e.right,c=e.splitAxis,p;if(p=Ve(i+32,s),p/4>Wi)throw new Error("MeshBVH: Cannot store child pointer greater than 32 bits.");return Mt[t+6]=p/4,p=Ve(p,a),Mt[t+7]=c,p}}function Xi(i,e){let t=(i.index?i.index.count:i.attributes.position.count)/3,n=t>2**16,o=n?4:2,r=e?new SharedArrayBuffer(t*o):new ArrayBuffer(t*o),s=n?new Uint32Array(r):new Uint16Array(r);for(let a=0,c=s.length;a<c;a++)s[a]=a;return s}function Gi(i,e,t,n,o){let{maxDepth:r,verbose:s,maxLeafTris:a,strategy:c,onProgress:p,indirect:f}=o,u=i._indirectBuffer,l=i.geometry,d=l.index?l.index.array:null,b=f?En:Mn,g=j(l),x=new Float32Array(6),h=!1,m=new ft;return Yt(e,t,n,m.boundingData,x),v(m,t,n,x),m;function y(A){p&&p(A/g)}function v(A,T,w,_=null,B=0){if(!h&&B>=r&&(h=!0,s&&(console.warn(`MeshBVH: Max depth of ${r} reached when generating BVH. Consider increasing maxDepth.`),console.warn(l))),w<=a||B>=r)return y(T+w),A.offset=T,A.count=w,A;let P=In(A.boundingData,_,e,T,w,c);if(P.axis===-1)return y(T+w),A.offset=T,A.count=w,A;let I=b(u,d,e,T,w,P);if(I===T||I===T+w)y(T+w),A.offset=T,A.count=w;else{A.splitAxis=P.axis;let S=new ft,M=T,E=I-T;A.left=S,Yt(e,M,E,S.boundingData,x),v(S,M,E,x,B+1);let N=new ft,V=I,$=w-E;A.right=N,Yt(e,V,$,N.boundingData,x),v(N,V,$,x,B+1)}return A}}function Cn(i,e){let t=i.geometry;e.indirect&&(i._indirectBuffer=Xi(t,e.useSharedArrayBuffer),_n(t)&&!e.verbose&&console.warn('MeshBVH: Provided geometry contains groups that do not fully span the vertex contents while using the "indirect" option. BVH may incorrectly report intersections on unrendered portions of the geometry.')),i._indirectBuffer||Bn(t,e);let n=e.useSharedArrayBuffer?SharedArrayBuffer:ArrayBuffer,o=Sn(t),r=e.indirect?Ne(t):Ce(t);i._roots=r.map(s=>{let a=Gi(i,o,s.offset,s.count,e),c=Kt(a),p=new n(32*c);return Nn(0,a,p),p})}import{Vector3 as tt,Matrix4 as zn,Line3 as Rn}from"three";import{Vector3 as Yi}from"three";var W=class{constructor(){this.min=1/0,this.max=-1/0}setFromPointsField(e,t){let n=1/0,o=-1/0;for(let r=0,s=e.length;r<s;r++){let c=e[r][t];n=c<n?c:n,o=c>o?c:o}this.min=n,this.max=o}setFromPoints(e,t){let n=1/0,o=-1/0;for(let r=0,s=t.length;r<s;r++){let a=t[r],c=e.dot(a);n=c<n?c:n,o=c>o?c:o}this.min=n,this.max=o}isSeparated(e){return this.min>e.max||e.min>this.max}};W.prototype.setFromBox=(function(){let i=new Yi;return function(t,n){let o=n.min,r=n.max,s=1/0,a=-1/0;for(let c=0;c<=1;c++)for(let p=0;p<=1;p++)for(let f=0;f<=1;f++){i.x=o.x*c+r.x*(1-c),i.y=o.y*p+r.y*(1-p),i.z=o.z*f+r.z*(1-f);let u=t.dot(i);s=Math.min(u,s),a=Math.max(u,a)}this.min=s,this.max=a}})();var Os=(function(){let i=new W;return function(t,n){let o=t.points,r=t.satAxes,s=t.satBounds,a=n.points,c=n.satAxes,p=n.satBounds;for(let f=0;f<3;f++){let u=s[f],l=r[f];if(i.setFromPoints(l,a),u.isSeparated(i))return!1}for(let f=0;f<3;f++){let u=p[f],l=c[f];if(i.setFromPoints(l,o),u.isSeparated(i))return!1}}})();import{Triangle as Ji,Vector3 as X,Line3 as pt,Sphere as Qi,Plane as to}from"three";import{Vector3 as ot,Vector2 as ji,Plane as Zi,Line3 as Ki}from"three";var $i=(function(){let i=new ot,e=new ot,t=new ot;return function(o,r,s){let a=o.start,c=i,p=r.start,f=e;t.subVectors(a,p),i.subVectors(o.end,o.start),e.subVectors(r.end,r.start);let u=t.dot(f),l=f.dot(c),d=f.dot(f),b=t.dot(c),x=c.dot(c)*d-l*l,h,m;x!==0?h=(u*l-b*d)/x:h=0,m=(u+h*l)/d,s.x=h,s.y=m}})(),Et=(function(){let i=new ji,e=new ot,t=new ot;return function(o,r,s,a){$i(o,r,i);let c=i.x,p=i.y;if(c>=0&&c<=1&&p>=0&&p<=1){o.at(c,s),r.at(p,a);return}else if(c>=0&&c<=1){p<0?r.at(0,a):r.at(1,a),o.closestPointToPoint(a,!0,s);return}else if(p>=0&&p<=1){c<0?o.at(0,s):o.at(1,s),r.closestPointToPoint(s,!0,a);return}else{let f;c<0?f=o.start:f=o.end;let u;p<0?u=r.start:u=r.end;let l=e,d=t;if(o.closestPointToPoint(u,!0,e),r.closestPointToPoint(f,!0,t),l.distanceToSquared(u)<=d.distanceToSquared(f)){s.copy(l),a.copy(u);return}else{s.copy(f),a.copy(d);return}}}})(),Ln=(function(){let i=new ot,e=new ot,t=new Zi,n=new Ki;return function(r,s){let{radius:a,center:c}=r,{a:p,b:f,c:u}=s;if(n.start=p,n.end=f,n.closestPointToPoint(c,!0,i).distanceTo(c)<=a||(n.start=p,n.end=u,n.closestPointToPoint(c,!0,i).distanceTo(c)<=a)||(n.start=f,n.end=u,n.closestPointToPoint(c,!0,i).distanceTo(c)<=a))return!0;let g=s.getPlane(t);if(Math.abs(g.distanceToPoint(c))<=a){let h=g.projectPoint(c,e);if(s.containsPoint(h))return!0}return!1}})();var eo=1e-15;function ke(i){return Math.abs(i)<eo}var H=class extends Ji{constructor(...e){super(...e),this.isExtendedTriangle=!0,this.satAxes=new Array(4).fill().map(()=>new X),this.satBounds=new Array(4).fill().map(()=>new W),this.points=[this.a,this.b,this.c],this.sphere=new Qi,this.plane=new to,this.needsUpdate=!0}intersectsSphere(e){return Ln(e,this)}update(){let e=this.a,t=this.b,n=this.c,o=this.points,r=this.satAxes,s=this.satBounds,a=r[0],c=s[0];this.getNormal(a),c.setFromPoints(a,o);let p=r[1],f=s[1];p.subVectors(e,t),f.setFromPoints(p,o);let u=r[2],l=s[2];u.subVectors(t,n),l.setFromPoints(u,o);let d=r[3],b=s[3];d.subVectors(n,e),b.setFromPoints(d,o),this.sphere.setFromPoints(this.points),this.plane.setFromNormalAndCoplanarPoint(a,e),this.needsUpdate=!1}};H.prototype.closestPointToSegment=(function(){let i=new X,e=new X,t=new pt;return function(o,r=null,s=null){let{start:a,end:c}=o,p=this.points,f,u=1/0;for(let l=0;l<3;l++){let d=(l+1)%3;t.start.copy(p[l]),t.end.copy(p[d]),Et(t,o,i,e),f=i.distanceToSquared(e),f<u&&(u=f,r&&r.copy(i),s&&s.copy(e))}return this.closestPointToPoint(a,i),f=a.distanceToSquared(i),f<u&&(u=f,r&&r.copy(i),s&&s.copy(a)),this.closestPointToPoint(c,i),f=c.distanceToSquared(i),f<u&&(u=f,r&&r.copy(i),s&&s.copy(c)),Math.sqrt(u)}})();H.prototype.intersectsTriangle=(function(){let i=new H,e=new Array(3),t=new Array(3),n=new W,o=new W,r=new X,s=new X,a=new X,c=new X,p=new X,f=new pt,u=new pt,l=new pt,d=new X;function b(g,x,h){let m=g.points,y=0,v=-1;for(let A=0;A<3;A++){let{start:T,end:w}=f;T.copy(m[A]),w.copy(m[(A+1)%3]),f.delta(s);let _=ke(x.distanceToPoint(T));if(ke(x.normal.dot(s))&&_){h.copy(f),y=2;break}let B=x.intersectLine(f,d);if(!B&&_&&d.copy(T),(B||_)&&!ke(d.distanceTo(w))){if(y<=1)(y===1?h.start:h.end).copy(d),_&&(v=y);else if(y>=2){(v===1?h.start:h.end).copy(d),y=2;break}if(y++,y===2&&v===-1)break}}return y}return function(x,h=null,m=!1){this.needsUpdate&&this.update(),x.isExtendedTriangle?x.needsUpdate&&x.update():(i.copy(x),i.update(),x=i);let y=this.plane,v=x.plane;if(Math.abs(y.normal.dot(v.normal))>1-1e-10){let A=this.satBounds,T=this.satAxes;t[0]=x.a,t[1]=x.b,t[2]=x.c;for(let B=0;B<4;B++){let P=A[B],I=T[B];if(n.setFromPoints(I,t),P.isSeparated(n))return!1}let w=x.satBounds,_=x.satAxes;e[0]=this.a,e[1]=this.b,e[2]=this.c;for(let B=0;B<4;B++){let P=w[B],I=_[B];if(n.setFromPoints(I,e),P.isSeparated(n))return!1}for(let B=0;B<4;B++){let P=T[B];for(let I=0;I<4;I++){let S=_[I];if(r.crossVectors(P,S),n.setFromPoints(r,e),o.setFromPoints(r,t),n.isSeparated(o))return!1}}return h&&(m||console.warn("ExtendedTriangle.intersectsTriangle: Triangles are coplanar which does not support an output edge. Setting edge to 0, 0, 0."),h.start.set(0,0,0),h.end.set(0,0,0)),!0}else{let A=b(this,v,u);if(A===1&&x.containsPoint(u.end))return h&&(h.start.copy(u.end),h.end.copy(u.end)),!0;if(A!==2)return!1;let T=b(x,y,l);if(T===1&&this.containsPoint(l.end))return h&&(h.start.copy(l.end),h.end.copy(l.end)),!0;if(T!==2)return!1;if(u.delta(a),l.delta(c),a.dot(c)<0){let M=l.start;l.start=l.end,l.end=M}let w=u.start.dot(a),_=u.end.dot(a),B=l.start.dot(a),P=l.end.dot(a),I=_<B,S=w<P;return w!==P&&B!==_&&I===S?!1:(h&&(p.subVectors(u.start,l.start),p.dot(a)>0?h.start.copy(u.start):h.start.copy(l.start),p.subVectors(u.end,l.end),p.dot(a)<0?h.end.copy(u.end):h.end.copy(l.end)),!0)}}})();H.prototype.distanceToPoint=(function(){let i=new X;return function(t){return this.closestPointToPoint(t,i),t.distanceTo(i)}})();H.prototype.distanceToTriangle=(function(){let i=new X,e=new X,t=["a","b","c"],n=new pt,o=new pt;return function(s,a=null,c=null){let p=a||c?n:null;if(this.intersectsTriangle(s,p))return(a||c)&&(a&&p.getCenter(a),c&&p.getCenter(c)),0;let f=1/0;for(let u=0;u<3;u++){let l,d=t[u],b=s[d];this.closestPointToPoint(b,i),l=b.distanceToSquared(i),l<f&&(f=l,a&&a.copy(i),c&&c.copy(b));let g=this[d];s.closestPointToPoint(g,i),l=g.distanceToSquared(i),l<f&&(f=l,a&&a.copy(g),c&&c.copy(i))}for(let u=0;u<3;u++){let l=t[u],d=t[(u+1)%3];n.set(this[l],this[d]);for(let b=0;b<3;b++){let g=t[b],x=t[(b+1)%3];o.set(s[g],s[x]),Et(n,o,i,e);let h=i.distanceToSquared(e);h<f&&(f=h,a&&a.copy(i),c&&c.copy(e))}}return Math.sqrt(f)}})();var U=class{constructor(e,t,n){this.isOrientedBox=!0,this.min=new tt,this.max=new tt,this.matrix=new zn,this.invMatrix=new zn,this.points=new Array(8).fill().map(()=>new tt),this.satAxes=new Array(3).fill().map(()=>new tt),this.satBounds=new Array(3).fill().map(()=>new W),this.alignedSatBounds=new Array(3).fill().map(()=>new W),this.needsUpdate=!1,e&&this.min.copy(e),t&&this.max.copy(t),n&&this.matrix.copy(n)}set(e,t,n){this.min.copy(e),this.max.copy(t),this.matrix.copy(n),this.needsUpdate=!0}copy(e){this.min.copy(e.min),this.max.copy(e.max),this.matrix.copy(e.matrix),this.needsUpdate=!0}};U.prototype.update=(function(){return function(){let e=this.matrix,t=this.min,n=this.max,o=this.points;for(let p=0;p<=1;p++)for(let f=0;f<=1;f++)for(let u=0;u<=1;u++){let l=1*p|2*f|4*u,d=o[l];d.x=p?n.x:t.x,d.y=f?n.y:t.y,d.z=u?n.z:t.z,d.applyMatrix4(e)}let r=this.satBounds,s=this.satAxes,a=o[0];for(let p=0;p<3;p++){let f=s[p],u=r[p],l=1<<p,d=o[l];f.subVectors(a,d),u.setFromPoints(f,o)}let c=this.alignedSatBounds;c[0].setFromPointsField(o,"x"),c[1].setFromPointsField(o,"y"),c[2].setFromPointsField(o,"z"),this.invMatrix.copy(this.matrix).invert(),this.needsUpdate=!1}})();U.prototype.intersectsBox=(function(){let i=new W;return function(t){this.needsUpdate&&this.update();let n=t.min,o=t.max,r=this.satBounds,s=this.satAxes,a=this.alignedSatBounds;if(i.min=n.x,i.max=o.x,a[0].isSeparated(i)||(i.min=n.y,i.max=o.y,a[1].isSeparated(i))||(i.min=n.z,i.max=o.z,a[2].isSeparated(i)))return!1;for(let c=0;c<3;c++){let p=s[c],f=r[c];if(i.setFromBox(p,t),f.isSeparated(i))return!1}return!0}})();U.prototype.intersectsTriangle=(function(){let i=new H,e=new Array(3),t=new W,n=new W,o=new tt;return function(s){this.needsUpdate&&this.update(),s.isExtendedTriangle?s.needsUpdate&&s.update():(i.copy(s),i.update(),s=i);let a=this.satBounds,c=this.satAxes;e[0]=s.a,e[1]=s.b,e[2]=s.c;for(let l=0;l<3;l++){let d=a[l],b=c[l];if(t.setFromPoints(b,e),d.isSeparated(t))return!1}let p=s.satBounds,f=s.satAxes,u=this.points;for(let l=0;l<3;l++){let d=p[l],b=f[l];if(t.setFromPoints(b,u),d.isSeparated(t))return!1}for(let l=0;l<3;l++){let d=c[l];for(let b=0;b<4;b++){let g=f[b];if(o.crossVectors(d,g),t.setFromPoints(o,e),n.setFromPoints(o,u),t.isSeparated(n))return!1}}return!0}})();U.prototype.closestPointToPoint=(function(){return function(e,t){return this.needsUpdate&&this.update(),t.copy(e).applyMatrix4(this.invMatrix).clamp(this.min,this.max).applyMatrix4(this.matrix),t}})();U.prototype.distanceToPoint=(function(){let i=new tt;return function(t){return this.closestPointToPoint(t,i),t.distanceTo(i)}})();U.prototype.distanceToBox=(function(){let i=["x","y","z"],e=new Array(12).fill().map(()=>new Rn),t=new Array(12).fill().map(()=>new Rn),n=new tt,o=new tt;return function(s,a=0,c=null,p=null){if(this.needsUpdate&&this.update(),this.intersectsBox(s))return(c||p)&&(s.getCenter(o),this.closestPointToPoint(o,n),s.closestPointToPoint(n,o),c&&c.copy(n),p&&p.copy(o)),0;let f=a*a,u=s.min,l=s.max,d=this.points,b=1/0;for(let x=0;x<8;x++){let h=d[x];o.copy(h).clamp(u,l);let m=h.distanceToSquared(o);if(m<b&&(b=m,c&&c.copy(h),p&&p.copy(o),m<f))return Math.sqrt(m)}let g=0;for(let x=0;x<3;x++)for(let h=0;h<=1;h++)for(let m=0;m<=1;m++){let y=(x+1)%3,v=(x+2)%3,A=h<<y|m<<v,T=1<<x|h<<y|m<<v,w=d[A],_=d[T];e[g].set(w,_);let P=i[x],I=i[y],S=i[v],M=t[g],E=M.start,N=M.end;E[P]=u[P],E[I]=h?u[I]:l[I],E[S]=m?u[S]:l[I],N[P]=l[P],N[I]=h?u[I]:l[I],N[S]=m?u[S]:l[I],g++}for(let x=0;x<=1;x++)for(let h=0;h<=1;h++)for(let m=0;m<=1;m++){o.x=x?l.x:u.x,o.y=h?l.y:u.y,o.z=m?l.z:u.z,this.closestPointToPoint(o,n);let y=o.distanceToSquared(n);if(y<b&&(b=y,c&&c.copy(n),p&&p.copy(o),y<f))return Math.sqrt(y)}for(let x=0;x<12;x++){let h=e[x];for(let m=0;m<12;m++){let y=t[m];Et(h,y,n,o);let v=n.distanceToSquared(o);if(v<b&&(b=v,c&&c.copy(n),p&&p.copy(o),v<f))return Math.sqrt(v)}}return Math.sqrt(b)}})();var et=class{constructor(e){this._getNewPrimitive=e,this._primitives=[]}getPrimitive(){let e=this._primitives;return e.length===0?this._getNewPrimitive():e.pop()}releasePrimitive(e){this._primitives.push(e)}};var Oe=class extends et{constructor(){super(()=>new H)}},q=new Oe;import{Box3 as no}from"three";var He=class{constructor(){this.float32Array=null,this.uint16Array=null,this.uint32Array=null;let e=[],t=null;this.setBuffer=n=>{t&&e.push(t),t=n,this.float32Array=new Float32Array(n),this.uint16Array=new Uint16Array(n),this.uint32Array=new Uint32Array(n)},this.clearBuffer=()=>{t=null,this.float32Array=null,this.uint16Array=null,this.uint32Array=null,e.length!==0&&this.setBuffer(e.pop())}}},F=new He;var nt,mt,dt=[],Jt=new et(()=>new no);function Un(i,e,t,n,o,r){nt=Jt.getPrimitive(),mt=Jt.getPrimitive(),dt.push(nt,mt),F.setBuffer(i._roots[e]);let s=qe(0,i.geometry,t,n,o,r);F.clearBuffer(),Jt.releasePrimitive(nt),Jt.releasePrimitive(mt),dt.pop(),dt.pop();let a=dt.length;return a>0&&(mt=dt[a-1],nt=dt[a-2]),s}function qe(i,e,t,n,o=null,r=0,s=0){let{float32Array:a,uint16Array:c,uint32Array:p}=F,f=i*2;if(L(f,c)){let l=z(i,p),d=R(f,c);return D(i,a,nt),n(l,d,!1,s,r+i,nt)}else{let P=function(S){let{uint16Array:M,uint32Array:E}=F,N=S*2;for(;!L(N,M);)S=O(S),N=S*2;return z(S,E)},I=function(S){let{uint16Array:M,uint32Array:E}=F,N=S*2;for(;!L(N,M);)S=k(S,E),N=S*2;return z(S,E)+R(N,M)},l=O(i),d=k(i,p),b=l,g=d,x,h,m,y;if(o&&(m=nt,y=mt,D(b,a,m),D(g,a,y),x=o(m),h=o(y),h<x)){b=d,g=l;let S=x;x=h,h=S,m=y}m||(m=nt,D(b,a,m));let v=L(b*2,c),A=t(m,v,x,s+1,r+b),T;if(A===2){let S=P(b),E=I(b)-S;T=n(S,E,!0,s+1,r+b,m)}else T=A&&qe(b,e,t,n,o,r,s+1);if(T)return!0;y=mt,D(g,a,y);let w=L(g*2,c),_=t(y,w,h,s+1,r+g),B;if(_===2){let S=P(g),E=I(g)-S;B=n(S,E,!0,s+1,r+g,y)}else B=_&&qe(g,e,t,n,o,r,s+1);return!!B}}import{Vector3 as Vn}from"three";var Dt=new Vn,We=new Vn;function kn(i,e,t={},n=0,o=1/0){let r=n*n,s=o*o,a=1/0,c=null;if(i.shapecast({boundsTraverseOrder:f=>(Dt.copy(e).clamp(f.min,f.max),Dt.distanceToSquared(e)),intersectsBounds:(f,u,l)=>l<a&&l<s,intersectsTriangle:(f,u)=>{f.closestPointToPoint(e,Dt);let l=e.distanceToSquared(Dt);return l<a&&(We.copy(Dt),a=l,c=u),l<r}}),a===1/0)return null;let p=Math.sqrt(a);return t.point?t.point.copy(We):t.point=We.clone(),t.distance=p,t.faceIndex=c,t}import{Vector3 as K,Vector2 as Ft,Triangle as te,DoubleSide as io,BackSide as oo}from"three";var ht=new K,xt=new K,yt=new K,ee=new Ft,ne=new Ft,ie=new Ft,On=new K,Hn=new K,qn=new K,oe=new K;function so(i,e,t,n,o,r,s,a){let c;if(r===oo?c=i.intersectTriangle(n,t,e,!0,o):c=i.intersectTriangle(e,t,n,r!==io,o),c===null)return null;let p=i.origin.distanceTo(o);return p<s||p>a?null:{distance:p,point:o.clone()}}function ro(i,e,t,n,o,r,s,a,c,p,f){ht.fromBufferAttribute(e,r),xt.fromBufferAttribute(e,s),yt.fromBufferAttribute(e,a);let u=so(i,ht,xt,yt,oe,c,p,f);if(u){n&&(ee.fromBufferAttribute(n,r),ne.fromBufferAttribute(n,s),ie.fromBufferAttribute(n,a),u.uv=te.getInterpolation(oe,ht,xt,yt,ee,ne,ie,new Ft)),o&&(ee.fromBufferAttribute(o,r),ne.fromBufferAttribute(o,s),ie.fromBufferAttribute(o,a),u.uv1=te.getInterpolation(oe,ht,xt,yt,ee,ne,ie,new Ft)),t&&(On.fromBufferAttribute(t,r),Hn.fromBufferAttribute(t,s),qn.fromBufferAttribute(t,a),u.normal=te.getInterpolation(oe,ht,xt,yt,On,Hn,qn,new K),u.normal.dot(i.direction)>0&&u.normal.multiplyScalar(-1));let l={a:r,b:s,c:a,normal:new K,materialIndex:0};te.getNormal(ht,xt,yt,l.normal),u.face=l,u.faceIndex=r}return u}function bt(i,e,t,n,o,r,s){let a=n*3,c=a+0,p=a+1,f=a+2,u=i.index;i.index&&(c=u.getX(c),p=u.getX(p),f=u.getX(f));let{position:l,normal:d,uv:b,uv1:g}=i.attributes,x=ro(t,l,d,b,g,c,p,f,e,r,s);return x?(x.faceIndex=n,o&&o.push(x),x):null}import{Vector2 as ae,Vector3 as Nt,Triangle as Xe}from"three";function C(i,e,t,n){let o=i.a,r=i.b,s=i.c,a=e,c=e+1,p=e+2;t&&(a=t.getX(a),c=t.getX(c),p=t.getX(p)),o.x=n.getX(a),o.y=n.getY(a),o.z=n.getZ(a),r.x=n.getX(c),r.y=n.getY(c),r.z=n.getZ(c),s.x=n.getX(p),s.y=n.getY(p),s.z=n.getZ(p)}var se=new Nt,re=new Nt,ce=new Nt,Wn=new ae,Xn=new ae,Gn=new ae;function co(i,e,t,n){let o=e.getIndex().array,r=e.getAttribute("position"),s=e.getAttribute("uv"),a=o[t*3],c=o[t*3+1],p=o[t*3+2];se.fromBufferAttribute(r,a),re.fromBufferAttribute(r,c),ce.fromBufferAttribute(r,p);let f=0,u=e.groups,l=t*3;for(let b=0,g=u.length;b<g;b++){let x=u[b],{start:h,count:m}=x;if(l>=h&&l<h+m){f=x.materialIndex;break}}let d=null;return s&&(Wn.fromBufferAttribute(s,a),Xn.fromBufferAttribute(s,c),Gn.fromBufferAttribute(s,p),n&&n.uv?d=n.uv:d=new ae,Xe.getInterpolation(i,se,re,ce,Wn,Xn,Gn,d)),n?(n.face||(n.face={}),n.face.a=a,n.face.b=c,n.face.c=p,n.face.materialIndex=f,n.face.normal||(n.face.normal=new Nt),Xe.getNormal(se,re,ce,n.face.normal),d&&(n.uv=d),n):{face:{a,b:c,c:p,materialIndex:f,normal:Xe.getNormal(se,re,ce,new Nt)},uv:d}}function Yn(i,e,t,n,o,r,s,a){let{geometry:c,_indirectBuffer:p}=i;for(let f=n,u=n+o;f<u;f++)bt(c,e,t,f,r,s,a)}function jn(i,e,t,n,o,r,s){let{geometry:a,_indirectBuffer:c}=i,p=1/0,f=null;for(let u=n,l=n+o;u<l;u++){let d;d=bt(a,e,t,u,null,r,s),d&&d.distance<p&&(f=d,p=d.distance)}return f}function Zn(i,e,t,n,o,r,s){let{geometry:a}=t,{index:c}=a,p=a.attributes.position;for(let f=i,u=e+i;f<u;f++){let l;if(l=f,C(s,l*3,c,p),s.needsUpdate=!0,n(s,l,o,r))return!0}return!1}function Kn(i,e=null){e&&Array.isArray(e)&&(e=new Set(e));let t=i.geometry,n=t.index?t.index.array:null,o=t.attributes.position,r,s,a,c,p=0,f=i._roots;for(let l=0,d=f.length;l<d;l++)r=f[l],s=new Uint32Array(r),a=new Uint16Array(r),c=new Float32Array(r),u(0,p),p+=r.byteLength;function u(l,d,b=!1){let g=l*2;if(a[g+15]===65535){let h=s[l+6],m=a[g+14],y=1/0,v=1/0,A=1/0,T=-1/0,w=-1/0,_=-1/0;for(let B=3*h,P=3*(h+m);B<P;B++){let I=n[B],S=o.getX(I),M=o.getY(I),E=o.getZ(I);S<y&&(y=S),S>T&&(T=S),M<v&&(v=M),M>w&&(w=M),E<A&&(A=E),E>_&&(_=E)}return c[l+0]!==y||c[l+1]!==v||c[l+2]!==A||c[l+3]!==T||c[l+4]!==w||c[l+5]!==_?(c[l+0]=y,c[l+1]=v,c[l+2]=A,c[l+3]=T,c[l+4]=w,c[l+5]=_,!0):!1}else{let h=l+8,m=s[l+6],y=h+d,v=m+d,A=b,T=!1,w=!1;e?A||(T=e.has(y),w=e.has(v),A=!T&&!w):(T=!0,w=!0);let _=A||T,B=A||w,P=!1;_&&(P=u(h,d,A));let I=!1;B&&(I=u(m,d,A));let S=P||I;if(S)for(let M=0;M<3;M++){let E=h+M,N=m+M,V=c[E],$=c[E+3],St=c[N],Pt=c[N+3];c[l+M]=V<St?V:St,c[l+M+3]=$>Pt?$:Pt}return S}}}function G(i,e,t,n,o){let r,s,a,c,p,f,u=1/t.direction.x,l=1/t.direction.y,d=1/t.direction.z,b=t.origin.x,g=t.origin.y,x=t.origin.z,h=e[i],m=e[i+3],y=e[i+1],v=e[i+3+1],A=e[i+2],T=e[i+3+2];return u>=0?(r=(h-b)*u,s=(m-b)*u):(r=(m-b)*u,s=(h-b)*u),l>=0?(a=(y-g)*l,c=(v-g)*l):(a=(v-g)*l,c=(y-g)*l),r>c||a>s||((a>r||isNaN(r))&&(r=a),(c<s||isNaN(s))&&(s=c),d>=0?(p=(A-x)*d,f=(T-x)*d):(p=(T-x)*d,f=(A-x)*d),r>f||p>s)?!1:((p>r||r!==r)&&(r=p),(f<s||s!==s)&&(s=f),r<=o&&s>=n)}function $n(i,e,t,n,o,r,s,a){let{geometry:c,_indirectBuffer:p}=i;for(let f=n,u=n+o;f<u;f++){let l=p?p[f]:f;bt(c,e,t,l,r,s,a)}}function Jn(i,e,t,n,o,r,s){let{geometry:a,_indirectBuffer:c}=i,p=1/0,f=null;for(let u=n,l=n+o;u<l;u++){let d;d=bt(a,e,t,c?c[u]:u,null,r,s),d&&d.distance<p&&(f=d,p=d.distance)}return f}function Qn(i,e,t,n,o,r,s){let{geometry:a}=t,{index:c}=a,p=a.attributes.position;for(let f=i,u=e+i;f<u;f++){let l;if(l=t.resolveTriangleIndex(f),C(s,l*3,c,p),s.needsUpdate=!0,n(s,l,o,r))return!0}return!1}function ti(i,e,t,n,o,r,s){F.setBuffer(i._roots[e]),Ge(0,i,t,n,o,r,s),F.clearBuffer()}function Ge(i,e,t,n,o,r,s){let{float32Array:a,uint16Array:c,uint32Array:p}=F,f=i*2;if(L(f,c)){let l=z(i,p),d=R(f,c);Yn(e,t,n,l,d,o,r,s)}else{let l=O(i);G(l,a,n,r,s)&&Ge(l,e,t,n,o,r,s);let d=k(i,p);G(d,a,n,r,s)&&Ge(d,e,t,n,o,r,s)}}var ao=["x","y","z"];function ei(i,e,t,n,o,r){F.setBuffer(i._roots[e]);let s=Ye(0,i,t,n,o,r);return F.clearBuffer(),s}function Ye(i,e,t,n,o,r){let{float32Array:s,uint16Array:a,uint32Array:c}=F,p=i*2;if(L(p,a)){let u=z(i,c),l=R(p,a);return jn(e,t,n,u,l,o,r)}else{let u=ut(i,c),l=ao[u],b=n.direction[l]>=0,g,x;b?(g=O(i),x=k(i,c)):(g=k(i,c),x=O(i));let m=G(g,s,n,o,r)?Ye(g,e,t,n,o,r):null;if(m){let A=m.point[l];if(b?A<=s[x+u]:A>=s[x+u+3])return m}let v=G(x,s,n,o,r)?Ye(x,e,t,n,o,r):null;return m&&v?m.distance<=v.distance?m:v:m||v||null}}import{Box3 as lo,Matrix4 as fo}from"three";var le=new lo,gt=new H,At=new H,Ct=new fo,ni=new U,fe=new U;function ii(i,e,t,n){F.setBuffer(i._roots[e]);let o=je(0,i,t,n);return F.clearBuffer(),o}function je(i,e,t,n,o=null){let{float32Array:r,uint16Array:s,uint32Array:a}=F,c=i*2;if(o===null&&(t.boundingBox||t.computeBoundingBox(),ni.set(t.boundingBox.min,t.boundingBox.max,n),o=ni),L(c,s)){let f=e.geometry,u=f.index,l=f.attributes.position,d=t.index,b=t.attributes.position,g=z(i,a),x=R(c,s);if(Ct.copy(n).invert(),t.boundsTree)return D(i,r,fe),fe.matrix.copy(Ct),fe.needsUpdate=!0,t.boundsTree.shapecast({intersectsBounds:m=>fe.intersectsBox(m),intersectsTriangle:m=>{m.a.applyMatrix4(n),m.b.applyMatrix4(n),m.c.applyMatrix4(n),m.needsUpdate=!0;for(let y=g*3,v=(x+g)*3;y<v;y+=3)if(C(At,y,u,l),At.needsUpdate=!0,m.intersectsTriangle(At))return!0;return!1}});for(let h=g*3,m=(x+g)*3;h<m;h+=3){C(gt,h,u,l),gt.a.applyMatrix4(Ct),gt.b.applyMatrix4(Ct),gt.c.applyMatrix4(Ct),gt.needsUpdate=!0;for(let y=0,v=d.count;y<v;y+=3)if(C(At,y,d,b),At.needsUpdate=!0,gt.intersectsTriangle(At))return!0}}else{let f=i+8,u=a[i+6];return D(f,r,le),!!(o.intersectsBox(le)&&je(f,e,t,n,o)||(D(u,r,le),o.intersectsBox(le)&&je(u,e,t,n,o)))}}import{Matrix4 as uo,Vector3 as pe}from"three";var ue=new uo,Ze=new U,Lt=new U,po=new pe,mo=new pe,ho=new pe,xo=new pe;function oi(i,e,t,n={},o={},r=0,s=1/0){e.boundingBox||e.computeBoundingBox(),Ze.set(e.boundingBox.min,e.boundingBox.max,t),Ze.needsUpdate=!0;let a=i.geometry,c=a.attributes.position,p=a.index,f=e.attributes.position,u=e.index,l=q.getPrimitive(),d=q.getPrimitive(),b=po,g=mo,x=null,h=null;o&&(x=ho,h=xo);let m=1/0,y=null,v=null;return ue.copy(t).invert(),Lt.matrix.copy(ue),i.shapecast({boundsTraverseOrder:A=>Ze.distanceToBox(A),intersectsBounds:(A,T,w)=>w<m&&w<s?(T&&(Lt.min.copy(A.min),Lt.max.copy(A.max),Lt.needsUpdate=!0),!0):!1,intersectsRange:(A,T)=>{if(e.boundsTree)return e.boundsTree.shapecast({boundsTraverseOrder:_=>Lt.distanceToBox(_),intersectsBounds:(_,B,P)=>P<m&&P<s,intersectsRange:(_,B)=>{for(let P=_,I=_+B;P<I;P++){C(d,3*P,u,f),d.a.applyMatrix4(t),d.b.applyMatrix4(t),d.c.applyMatrix4(t),d.needsUpdate=!0;for(let S=A,M=A+T;S<M;S++){C(l,3*S,p,c),l.needsUpdate=!0;let E=l.distanceToTriangle(d,b,x);if(E<m&&(g.copy(b),h&&h.copy(x),m=E,y=S,v=P),E<r)return!0}}}});{let w=j(e);for(let _=0,B=w;_<B;_++){C(d,3*_,u,f),d.a.applyMatrix4(t),d.b.applyMatrix4(t),d.c.applyMatrix4(t),d.needsUpdate=!0;for(let P=A,I=A+T;P<I;P++){C(l,3*P,p,c),l.needsUpdate=!0;let S=l.distanceToTriangle(d,b,x);if(S<m&&(g.copy(b),h&&h.copy(x),m=S,y=P,v=_),S<r)return!0}}}}}),q.releasePrimitive(l),q.releasePrimitive(d),m===1/0?null:(n.point?n.point.copy(g):n.point=g.clone(),n.distance=m,n.faceIndex=y,o&&(o.point?o.point.copy(h):o.point=h.clone(),o.point.applyMatrix4(ue),g.applyMatrix4(ue),o.distance=g.sub(o.point).length(),o.faceIndex=v),n)}function si(i,e=null){e&&Array.isArray(e)&&(e=new Set(e));let t=i.geometry,n=t.index?t.index.array:null,o=t.attributes.position,r,s,a,c,p=0,f=i._roots;for(let l=0,d=f.length;l<d;l++)r=f[l],s=new Uint32Array(r),a=new Uint16Array(r),c=new Float32Array(r),u(0,p),p+=r.byteLength;function u(l,d,b=!1){let g=l*2;if(a[g+15]===65535){let h=s[l+6],m=a[g+14],y=1/0,v=1/0,A=1/0,T=-1/0,w=-1/0,_=-1/0;for(let B=h,P=h+m;B<P;B++){let I=3*i.resolveTriangleIndex(B);for(let S=0;S<3;S++){let M=I+S;M=n?n[M]:M;let E=o.getX(M),N=o.getY(M),V=o.getZ(M);E<y&&(y=E),E>T&&(T=E),N<v&&(v=N),N>w&&(w=N),V<A&&(A=V),V>_&&(_=V)}}return c[l+0]!==y||c[l+1]!==v||c[l+2]!==A||c[l+3]!==T||c[l+4]!==w||c[l+5]!==_?(c[l+0]=y,c[l+1]=v,c[l+2]=A,c[l+3]=T,c[l+4]=w,c[l+5]=_,!0):!1}else{let h=l+8,m=s[l+6],y=h+d,v=m+d,A=b,T=!1,w=!1;e?A||(T=e.has(y),w=e.has(v),A=!T&&!w):(T=!0,w=!0);let _=A||T,B=A||w,P=!1;_&&(P=u(h,d,A));let I=!1;B&&(I=u(m,d,A));let S=P||I;if(S)for(let M=0;M<3;M++){let E=h+M,N=m+M,V=c[E],$=c[E+3],St=c[N],Pt=c[N+3];c[l+M]=V<St?V:St,c[l+M+3]=$>Pt?$:Pt}return S}}}function ri(i,e,t,n,o,r,s){F.setBuffer(i._roots[e]),Ke(0,i,t,n,o,r,s),F.clearBuffer()}function Ke(i,e,t,n,o,r,s){let{float32Array:a,uint16Array:c,uint32Array:p}=F,f=i*2;if(L(f,c)){let l=z(i,p),d=R(f,c);$n(e,t,n,l,d,o,r,s)}else{let l=O(i);G(l,a,n,r,s)&&Ke(l,e,t,n,o,r,s);let d=k(i,p);G(d,a,n,r,s)&&Ke(d,e,t,n,o,r,s)}}var yo=["x","y","z"];function ci(i,e,t,n,o,r){F.setBuffer(i._roots[e]);let s=$e(0,i,t,n,o,r);return F.clearBuffer(),s}function $e(i,e,t,n,o,r){let{float32Array:s,uint16Array:a,uint32Array:c}=F,p=i*2;if(L(p,a)){let u=z(i,c),l=R(p,a);return Jn(e,t,n,u,l,o,r)}else{let u=ut(i,c),l=yo[u],b=n.direction[l]>=0,g,x;b?(g=O(i),x=k(i,c)):(g=k(i,c),x=O(i));let m=G(g,s,n,o,r)?$e(g,e,t,n,o,r):null;if(m){let A=m.point[l];if(b?A<=s[x+u]:A>=s[x+u+3])return m}let v=G(x,s,n,o,r)?$e(x,e,t,n,o,r):null;return m&&v?m.distance<=v.distance?m:v:m||v||null}}import{Box3 as bo,Matrix4 as go}from"three";var de=new bo,vt=new H,Tt=new H,zt=new go,ai=new U,me=new U;function li(i,e,t,n){F.setBuffer(i._roots[e]);let o=Je(0,i,t,n);return F.clearBuffer(),o}function Je(i,e,t,n,o=null){let{float32Array:r,uint16Array:s,uint32Array:a}=F,c=i*2;if(o===null&&(t.boundingBox||t.computeBoundingBox(),ai.set(t.boundingBox.min,t.boundingBox.max,n),o=ai),L(c,s)){let f=e.geometry,u=f.index,l=f.attributes.position,d=t.index,b=t.attributes.position,g=z(i,a),x=R(c,s);if(zt.copy(n).invert(),t.boundsTree)return D(i,r,me),me.matrix.copy(zt),me.needsUpdate=!0,t.boundsTree.shapecast({intersectsBounds:m=>me.intersectsBox(m),intersectsTriangle:m=>{m.a.applyMatrix4(n),m.b.applyMatrix4(n),m.c.applyMatrix4(n),m.needsUpdate=!0;for(let y=g,v=x+g;y<v;y++)if(C(Tt,3*e.resolveTriangleIndex(y),u,l),Tt.needsUpdate=!0,m.intersectsTriangle(Tt))return!0;return!1}});for(let h=g,m=x+g;h<m;h++){let y=e.resolveTriangleIndex(h);C(vt,3*y,u,l),vt.a.applyMatrix4(zt),vt.b.applyMatrix4(zt),vt.c.applyMatrix4(zt),vt.needsUpdate=!0;for(let v=0,A=d.count;v<A;v+=3)if(C(Tt,v,d,b),Tt.needsUpdate=!0,vt.intersectsTriangle(Tt))return!0}}else{let f=i+8,u=a[i+6];return D(f,r,de),!!(o.intersectsBox(de)&&Je(f,e,t,n,o)||(D(u,r,de),o.intersectsBox(de)&&Je(u,e,t,n,o)))}}import{Matrix4 as Ao,Vector3 as xe}from"three";var he=new Ao,Qe=new U,Rt=new U,vo=new xe,To=new xe,wo=new xe,Bo=new xe;function fi(i,e,t,n={},o={},r=0,s=1/0){e.boundingBox||e.computeBoundingBox(),Qe.set(e.boundingBox.min,e.boundingBox.max,t),Qe.needsUpdate=!0;let a=i.geometry,c=a.attributes.position,p=a.index,f=e.attributes.position,u=e.index,l=q.getPrimitive(),d=q.getPrimitive(),b=vo,g=To,x=null,h=null;o&&(x=wo,h=Bo);let m=1/0,y=null,v=null;return he.copy(t).invert(),Rt.matrix.copy(he),i.shapecast({boundsTraverseOrder:A=>Qe.distanceToBox(A),intersectsBounds:(A,T,w)=>w<m&&w<s?(T&&(Rt.min.copy(A.min),Rt.max.copy(A.max),Rt.needsUpdate=!0),!0):!1,intersectsRange:(A,T)=>{if(e.boundsTree){let w=e.boundsTree;return w.shapecast({boundsTraverseOrder:_=>Rt.distanceToBox(_),intersectsBounds:(_,B,P)=>P<m&&P<s,intersectsRange:(_,B)=>{for(let P=_,I=_+B;P<I;P++){let S=w.resolveTriangleIndex(P);C(d,3*S,u,f),d.a.applyMatrix4(t),d.b.applyMatrix4(t),d.c.applyMatrix4(t),d.needsUpdate=!0;for(let M=A,E=A+T;M<E;M++){let N=i.resolveTriangleIndex(M);C(l,3*N,p,c),l.needsUpdate=!0;let V=l.distanceToTriangle(d,b,x);if(V<m&&(g.copy(b),h&&h.copy(x),m=V,y=M,v=P),V<r)return!0}}}})}else{let w=j(e);for(let _=0,B=w;_<B;_++){C(d,3*_,u,f),d.a.applyMatrix4(t),d.b.applyMatrix4(t),d.c.applyMatrix4(t),d.needsUpdate=!0;for(let P=A,I=A+T;P<I;P++){let S=i.resolveTriangleIndex(P);C(l,3*S,p,c),l.needsUpdate=!0;let M=l.distanceToTriangle(d,b,x);if(M<m&&(g.copy(b),h&&h.copy(x),m=M,y=P,v=_),M<r)return!0}}}}}),q.releasePrimitive(l),q.releasePrimitive(d),m===1/0?null:(n.point?n.point.copy(g):n.point=g.clone(),n.distance=m,n.faceIndex=y,o&&(o.point?o.point.copy(h):o.point=h.clone(),o.point.applyMatrix4(he),g.applyMatrix4(he),o.distance=g.sub(o.point).length(),o.faceIndex=v),n)}function ye(){return typeof SharedArrayBuffer<"u"}import{Box3 as Vt,Matrix4 as _o}from"three";var Ut=new F.constructor,be=new F.constructor,it=new et(()=>new Vt),wt=new Vt,Bt=new Vt,tn=new Vt,en=new Vt,nn=!1;function ui(i,e,t,n){if(nn)throw new Error("MeshBVH: Recursive calls to bvhcast not supported.");nn=!0;let o=i._roots,r=e._roots,s,a=0,c=0,p=new _o().copy(t).invert();for(let f=0,u=o.length;f<u;f++){Ut.setBuffer(o[f]),c=0;let l=it.getPrimitive();D(0,Ut.float32Array,l),l.applyMatrix4(p);for(let d=0,b=r.length;d<b&&(be.setBuffer(r[f]),s=Y(0,0,t,p,n,a,c,0,0,l),be.clearBuffer(),c+=r[d].length,!s);d++);if(it.releasePrimitive(l),Ut.clearBuffer(),a+=o[f].length,s)break}return nn=!1,s}function Y(i,e,t,n,o,r=0,s=0,a=0,c=0,p=null,f=!1){let u,l;f?(u=be,l=Ut):(u=Ut,l=be);let d=u.float32Array,b=u.uint32Array,g=u.uint16Array,x=l.float32Array,h=l.uint32Array,m=l.uint16Array,y=i*2,v=e*2,A=L(y,g),T=L(v,m),w=!1;if(T&&A)f?w=o(z(e,h),R(e*2,m),z(i,b),R(i*2,g),c,s+e,a,r+i):w=o(z(i,b),R(i*2,g),z(e,h),R(e*2,m),a,r+i,c,s+e);else if(T){let _=it.getPrimitive();D(e,x,_),_.applyMatrix4(t);let B=O(i),P=k(i,b);D(B,d,wt),D(P,d,Bt);let I=_.intersectsBox(wt),S=_.intersectsBox(Bt);w=I&&Y(e,B,n,t,o,s,r,c,a+1,_,!f)||S&&Y(e,P,n,t,o,s,r,c,a+1,_,!f),it.releasePrimitive(_)}else{let _=O(e),B=k(e,h);D(_,x,tn),D(B,x,en);let P=p.intersectsBox(tn),I=p.intersectsBox(en);if(P&&I)w=Y(i,_,t,n,o,r,s,a,c+1,p,f)||Y(i,B,t,n,o,r,s,a,c+1,p,f);else if(P)if(A)w=Y(i,_,t,n,o,r,s,a,c+1,p,f);else{let S=it.getPrimitive();S.copy(tn).applyMatrix4(t);let M=O(i),E=k(i,b);D(M,d,wt),D(E,d,Bt);let N=S.intersectsBox(wt),V=S.intersectsBox(Bt);w=N&&Y(_,M,n,t,o,s,r,c,a+1,S,!f)||V&&Y(_,E,n,t,o,s,r,c,a+1,S,!f),it.releasePrimitive(S)}else if(I)if(A)w=Y(i,B,t,n,o,r,s,a,c+1,p,f);else{let S=it.getPrimitive();S.copy(en).applyMatrix4(t);let M=O(i),E=k(i,b);D(M,d,wt),D(E,d,Bt);let N=S.intersectsBox(wt),V=S.intersectsBox(Bt);w=N&&Y(B,M,n,t,o,s,r,c,a+1,S,!f)||V&&Y(B,E,n,t,o,s,r,c,a+1,S,!f),it.releasePrimitive(S)}}return w}var ge=new U,di=new mi,Po={strategy:0,maxDepth:40,maxLeafTris:10,useSharedArrayBuffer:!1,setBoundingBox:!0,onProgress:null,indirect:!1,verbose:!0},st=class i{static serialize(e,t={}){t={cloneBuffers:!0,...t};let n=e.geometry,o=e._roots,r=e._indirectBuffer,s=n.getIndex(),a;return t.cloneBuffers?a={roots:o.map(c=>c.slice()),index:s?s.array.slice():null,indirectBuffer:r?r.slice():null}:a={roots:o,index:s?s.array:null,indirectBuffer:r},a}static deserialize(e,t,n={}){n={setIndex:!0,indirect:!!e.indirectBuffer,...n};let{index:o,roots:r,indirectBuffer:s}=e,a=new i(t,{...n,[Gt]:!0});if(a._roots=r,a._indirectBuffer=s||null,n.setIndex){let c=t.getIndex();if(c===null){let p=new So(e.index,1,!1);t.setIndex(p)}else c.array!==o&&(c.array.set(o),c.needsUpdate=!0)}return a}get indirect(){return!!this._indirectBuffer}constructor(e,t={}){if(e.isBufferGeometry){if(e.index&&e.index.isInterleavedBufferAttribute)throw new Error("MeshBVH: InterleavedBufferAttribute is not supported for the index attribute.")}else throw new Error("MeshBVH: Only BufferGeometries are supported.");if(t=Object.assign({...Po,[Gt]:!1},t),t.useSharedArrayBuffer&&!ye())throw new Error("MeshBVH: SharedArrayBuffer is not available.");this.geometry=e,this._roots=null,this._indirectBuffer=null,t[Gt]||(Cn(this,t),!e.boundingBox&&t.setBoundingBox&&(e.boundingBox=this.getBoundingBox(new mi))),this.resolveTriangleIndex=t.indirect?n=>this._indirectBuffer[n]:n=>n}refit(e=null){return(this.indirect?si:Kn)(this,e)}traverse(e,t=0){let n=this._roots[t],o=new Uint32Array(n),r=new Uint16Array(n);s(0);function s(a,c=0){let p=a*2,f=r[p+15]===65535;if(f){let u=o[a+6],l=r[p+14];e(c,f,new Float32Array(n,a*4,6),u,l)}else{let u=a+32/4,l=o[a+6],d=o[a+7];e(c,f,new Float32Array(n,a*4,6),d)||(s(u,c+1),s(l,c+1))}}}raycast(e,t=pi,n=0,o=1/0){let r=this._roots,s=this.geometry,a=[],c=t.isMaterial,p=Array.isArray(t),f=s.groups,u=c?t.side:t,l=this.indirect?ri:ti;for(let d=0,b=r.length;d<b;d++){let g=p?t[f[d].materialIndex].side:u,x=a.length;if(l(this,d,g,e,a,n,o),p){let h=f[d].materialIndex;for(let m=x,y=a.length;m<y;m++)a[m].face.materialIndex=h}}return a}raycastFirst(e,t=pi,n=0,o=1/0){let r=this._roots,s=this.geometry,a=t.isMaterial,c=Array.isArray(t),p=null,f=s.groups,u=a?t.side:t,l=this.indirect?ci:ei;for(let d=0,b=r.length;d<b;d++){let g=c?t[f[d].materialIndex].side:u,x=l(this,d,g,e,n,o);x!=null&&(p==null||x.distance<p.distance)&&(p=x,c&&(x.face.materialIndex=f[d].materialIndex))}return p}intersectsGeometry(e,t){let n=!1,o=this._roots,r=this.indirect?li:ii;for(let s=0,a=o.length;s<a&&(n=r(this,s,e,t),!n);s++);return n}shapecast(e){let t=q.getPrimitive(),n=this.indirect?Qn:Zn,{boundsTraverseOrder:o,intersectsBounds:r,intersectsRange:s,intersectsTriangle:a}=e;if(s&&a){let u=s;s=(l,d,b,g,x)=>u(l,d,b,g,x)?!0:n(l,d,this,a,b,g,t)}else s||(a?s=(u,l,d,b)=>n(u,l,this,a,d,b,t):s=(u,l,d)=>d);let c=!1,p=0,f=this._roots;for(let u=0,l=f.length;u<l;u++){let d=f[u];if(c=Un(this,u,r,s,o,p),c)break;p+=d.byteLength}return q.releasePrimitive(t),c}bvhcast(e,t,n){let{intersectsRanges:o,intersectsTriangles:r}=n,s=q.getPrimitive(),a=this.geometry.index,c=this.geometry.attributes.position,p=this.indirect?b=>{let g=this.resolveTriangleIndex(b);C(s,g*3,a,c)}:b=>{C(s,b*3,a,c)},f=q.getPrimitive(),u=e.geometry.index,l=e.geometry.attributes.position,d=e.indirect?b=>{let g=e.resolveTriangleIndex(b);C(f,g*3,u,l)}:b=>{C(f,b*3,u,l)};if(r){let b=(g,x,h,m,y,v,A,T)=>{for(let w=h,_=h+m;w<_;w++){d(w),f.a.applyMatrix4(t),f.b.applyMatrix4(t),f.c.applyMatrix4(t),f.needsUpdate=!0;for(let B=g,P=g+x;B<P;B++)if(p(B),s.needsUpdate=!0,r(s,f,B,w,y,v,A,T))return!0}return!1};if(o){let g=o;o=function(x,h,m,y,v,A,T,w){return g(x,h,m,y,v,A,T,w)?!0:b(x,h,m,y,v,A,T,w)}}else o=b}return ui(this,e,t,o)}intersectsBox(e,t){return ge.set(e.min,e.max,t),ge.needsUpdate=!0,this.shapecast({intersectsBounds:n=>ge.intersectsBox(n),intersectsTriangle:n=>ge.intersectsTriangle(n)})}intersectsSphere(e){return this.shapecast({intersectsBounds:t=>e.intersectsBox(t),intersectsTriangle:t=>t.intersectsSphere(e)})}closestPointToGeometry(e,t,n={},o={},r=0,s=1/0){return(this.indirect?fi:oi)(this,e,t,n,o,r,s)}closestPointToPoint(e,t={},n=0,o=1/0){return kn(this,e,t,n,o)}getBoundingBox(e){return e.makeEmpty(),this._roots.forEach(n=>{D(0,new Float32Array(n),di),e.union(di)}),e}};import{LineBasicMaterial as Io,BufferAttribute as hi,Box3 as Mo,Group as Eo,MeshBasicMaterial as Do,Object3D as Fo,BufferGeometry as No}from"three";var xi=new Mo,on=class extends Fo{get isMesh(){return!this.displayEdges}get isLineSegments(){return this.displayEdges}get isLine(){return this.displayEdges}constructor(e,t,n=10,o=0){super(),this.material=t,this.geometry=new No,this.name="MeshBVHRootHelper",this.depth=n,this.displayParents=!1,this.bvh=e,this.displayEdges=!0,this._group=o}raycast(){}update(){let e=this.geometry,t=this.bvh,n=this._group;if(e.dispose(),this.visible=!1,t){let o=this.depth-1,r=this.displayParents,s=0;t.traverse((l,d)=>{if(l>=o||d)return s++,!0;r&&s++},n);let a=0,c=new Float32Array(24*s);t.traverse((l,d,b)=>{let g=l>=o||d;if(g||r){D(0,b,xi);let{min:x,max:h}=xi;for(let m=-1;m<=1;m+=2){let y=m<0?x.x:h.x;for(let v=-1;v<=1;v+=2){let A=v<0?x.y:h.y;for(let T=-1;T<=1;T+=2){let w=T<0?x.z:h.z;c[a+0]=y,c[a+1]=A,c[a+2]=w,a+=3}}}return g}},n);let p,f;this.displayEdges?f=new Uint8Array([0,4,1,5,2,6,3,7,0,2,1,3,4,6,5,7,0,1,2,3,4,5,6,7]):f=new Uint8Array([0,1,2,2,1,3,4,6,5,6,7,5,1,4,5,0,4,1,2,3,6,3,7,6,0,2,4,2,6,4,1,5,3,3,5,7]),c.length>65535?p=new Uint32Array(f.length*s):p=new Uint16Array(f.length*s);let u=f.length;for(let l=0;l<s;l++){let d=l*8,b=l*u;for(let g=0;g<u;g++)p[b+g]=d+f[g]}e.setIndex(new hi(p,1,!1)),e.setAttribute("position",new hi(c,3,!1)),this.visible=!0}}},sn=class i extends Eo{get color(){return this.edgeMaterial.color}get opacity(){return this.edgeMaterial.opacity}set opacity(e){this.edgeMaterial.opacity=e,this.meshMaterial.opacity=e}constructor(e=null,t=null,n=10){e instanceof st&&(n=t||10,t=e,e=null),typeof t=="number"&&(n=t,t=null),super(),this.name="MeshBVHHelper",this.depth=n,this.mesh=e,this.bvh=t,this.displayParents=!1,this.displayEdges=!0,this._roots=[];let o=new Io({color:65416,transparent:!0,opacity:.3,depthWrite:!1}),r=new Do({color:65416,transparent:!0,opacity:.3,depthWrite:!1});r.color=o.color,this.edgeMaterial=o,this.meshMaterial=r,this.update()}update(){let e=this.bvh||this.mesh.geometry.boundsTree,t=e?e._roots.length:0;for(;this._roots.length>t;){let n=this._roots.pop();n.geometry.dispose(),this.remove(n)}for(let n=0;n<t;n++){let{depth:o,edgeMaterial:r,meshMaterial:s,displayParents:a,displayEdges:c}=this;if(n>=this._roots.length){let f=new on(e,r,o,n);this.add(f),this._roots.push(f)}let p=this._roots[n];p.bvh=e,p.depth=o,p.displayParents=a,p.displayEdges=c,p.material=c?r:s,p.update()}}updateMatrixWorld(...e){let t=this.mesh,n=this.parent;t!==null&&(t.updateWorldMatrix(!0,!1),n?this.matrix.copy(n.matrixWorld).invert().multiply(t.matrixWorld):this.matrix.copy(t.matrixWorld),this.matrix.decompose(this.position,this.quaternion,this.scale)),super.updateMatrixWorld(...e)}copy(e){this.depth=e.depth,this.mesh=e.mesh,this.bvh=e.bvh,this.opacity=e.opacity,this.color.copy(e.color)}clone(){return new i(this.mesh,this.bvh,this.depth)}dispose(){this.edgeMaterial.dispose(),this.meshMaterial.dispose();let e=this.children;for(let t=0,n=e.length;t<n;t++)e[t].geometry.dispose()}};import{Box3 as rn,Vector3 as Co}from"three";var kt=new rn,yi=new rn,_t=new Co;function bi(i){switch(typeof i){case"number":return 8;case"string":return i.length*2;case"boolean":return 4;default:return 0}}function Lo(i){return/(Uint|Int|Float)(8|16|32)Array/.test(i.constructor.name)}function zo(i,e){let t={nodeCount:0,leafNodeCount:0,depth:{min:1/0,max:-1/0},tris:{min:1/0,max:-1/0},splits:[0,0,0],surfaceAreaScore:0};return i.traverse((n,o,r,s,a)=>{let c=r[3]-r[0],p=r[4]-r[1],f=r[5]-r[2],u=2*(c*p+p*f+f*c);t.nodeCount++,o?(t.leafNodeCount++,t.depth.min=Math.min(n,t.depth.min),t.depth.max=Math.max(n,t.depth.max),t.tris.min=Math.min(a,t.tris.min),t.tris.max=Math.max(a,t.tris.max),t.surfaceAreaScore+=u*1.25*a):(t.splits[s]++,t.surfaceAreaScore+=u*1)},e),t.tris.min===1/0&&(t.tris.min=0,t.tris.max=0),t.depth.min===1/0&&(t.depth.min=0,t.depth.max=0),t}function Ro(i){return i._roots.map((e,t)=>zo(i,t))}function Uo(i){let e=new Set,t=[i],n=0;for(;t.length;){let o=t.pop();if(!e.has(o)){e.add(o);for(let r in o){if(!Object.hasOwn(o,r))continue;n+=bi(r);let s=o[r];s&&(typeof s=="object"||typeof s=="function")?Lo(s)||ye()&&s instanceof SharedArrayBuffer||s instanceof ArrayBuffer?n+=s.byteLength:t.push(s):n+=bi(s)}}}return n}function Vo(i){let e=i.geometry,t=[],n=e.index,o=e.getAttribute("position"),r=!0;return i.traverse((s,a,c,p,f)=>{let u={depth:s,isLeaf:a,boundingData:c,offset:p,count:f};t[s]=u,D(0,c,kt);let l=t[s-1];if(a)for(let d=p,b=p+f;d<b;d++){let g=i.resolveTriangleIndex(d),x=3*g,h=3*g+1,m=3*g+2;n&&(x=n.getX(x),h=n.getX(h),m=n.getX(m));let y;_t.fromBufferAttribute(o,x),y=kt.containsPoint(_t),_t.fromBufferAttribute(o,h),y=y&&kt.containsPoint(_t),_t.fromBufferAttribute(o,m),y=y&&kt.containsPoint(_t),console.assert(y,"Leaf bounds does not fully contain triangle."),r=r&&y}if(l){D(0,c,yi);let d=yi.containsBox(kt);console.assert(d,"Parent bounds does not fully contain child."),r=r&&d}}),r}function ko(i){let e=[];return i.traverse((t,n,o,r,s)=>{let a={bounds:D(0,o,new rn)};n?(a.count=s,a.offset=r):(a.left=null,a.right=null),e[t]=a;let c=e[t-1];c&&(c.left===null?c.left=a:c.right=a)}),e[0]}import{Ray as Oo,Matrix4 as Ho,Mesh as qo,Vector3 as Ti}from"three";function cn(i,e,t){return i===null?null:(i.point.applyMatrix4(e.matrixWorld),i.distance=i.point.distanceTo(t.ray.origin),i.object=e,i)}var Ae=new Oo,gi=new Ti,Ai=new Ho,Wo=qo.prototype.raycast,vi=new Ti;function Xo(i,e){if(this.geometry.boundsTree){if(this.material===void 0)return;Ai.copy(this.matrixWorld).invert(),Ae.copy(i.ray).applyMatrix4(Ai),jo(this.matrixWorld,vi),gi.copy(Ae.direction).multiply(vi);let t=gi.length(),n=i.near/t,o=i.far/t,r=this.geometry.boundsTree;if(i.firstHitOnly===!0){let s=cn(r.raycastFirst(Ae,this.material,n,o),this,i);s&&e.push(s)}else{let s=r.raycast(Ae,this.material,n,o);for(let a=0,c=s.length;a<c;a++){let p=cn(s[a],this,i);p&&e.push(p)}}}else Wo.call(this,i,e)}function Go(i){return this.boundsTree=new st(this,i),this.boundsTree}function Yo(){this.boundsTree=null}function jo(i,e){let t=i.elements,n=e.set(t[0],t[1],t[2]).length(),o=e.set(t[4],t[5],t[6]).length(),r=e.set(t[8],t[9],t[10]).length();return e.set(n,o,r)}import{DataTexture as Ii,FloatType as os,UnsignedIntType as ss,RGBAFormat as rs,RGIntegerFormat as cs,NearestFilter as Se,BufferAttribute as as}from"three";import{DataTexture as Zo,FloatType as ve,IntType as Te,UnsignedIntType as we,ByteType as wi,UnsignedByteType as Bi,ShortType as Ko,UnsignedShortType as $o,RedFormat as Jo,RGFormat as Qo,RGBAFormat as an,RedIntegerFormat as ts,RGIntegerFormat as es,RGBAIntegerFormat as ln,NearestFilter as _i}from"three";function ns(i){switch(i){case 1:return"R";case 2:return"RG";case 3:return"RGBA";case 4:return"RGBA"}throw new Error}function is(i){switch(i){case 1:return Jo;case 2:return Qo;case 3:return an;case 4:return an}}function Si(i){switch(i){case 1:return ts;case 2:return es;case 3:return ln;case 4:return ln}}var Ot=class extends Zo{constructor(){super(),this.minFilter=_i,this.magFilter=_i,this.generateMipmaps=!1,this.overrideItemSize=null,this._forcedType=null}updateFrom(e){let t=this.overrideItemSize,n=e.itemSize,o=e.count;if(t!==null){if(n*o%t!==0)throw new Error("VertexAttributeTexture: overrideItemSize must divide evenly into buffer length.");e.itemSize=t,e.count=o*n/t}let r=e.itemSize,s=e.count,a=e.normalized,c=e.array.constructor,p=c.BYTES_PER_ELEMENT,f=this._forcedType,u=r;if(f===null)switch(c){case Float32Array:f=ve;break;case Uint8Array:case Uint16Array:case Uint32Array:f=we;break;case Int8Array:case Int16Array:case Int32Array:f=Te;break}let l,d,b,g,x=ns(r);switch(f){case ve:b=1,d=is(r),a&&p===1?(g=c,x+="8",c===Uint8Array?l=Bi:(l=wi,x+="_SNORM")):(g=Float32Array,x+="32F",l=ve);break;case Te:x+=p*8+"I",b=a?Math.pow(2,c.BYTES_PER_ELEMENT*8-1):1,d=Si(r),p===1?(g=Int8Array,l=wi):p===2?(g=Int16Array,l=Ko):(g=Int32Array,l=Te);break;case we:x+=p*8+"UI",b=a?Math.pow(2,c.BYTES_PER_ELEMENT*8-1):1,d=Si(r),p===1?(g=Uint8Array,l=Bi):p===2?(g=Uint16Array,l=$o):(g=Uint32Array,l=we);break}u===3&&(d===an||d===ln)&&(u=4);let h=Math.ceil(Math.sqrt(s))||1,m=u*h*h,y=new g(m),v=e.normalized;e.normalized=!1;for(let A=0;A<s;A++){let T=u*A;y[T]=e.getX(A)/b,r>=2&&(y[T+1]=e.getY(A)/b),r>=3&&(y[T+2]=e.getZ(A)/b,u===4&&(y[T+3]=1)),r>=4&&(y[T+3]=e.getW(A)/b)}e.normalized=v,this.internalFormat=x,this.format=d,this.type=l,this.image.width=h,this.image.height=h,this.image.data=y,this.needsUpdate=!0,this.dispose(),e.itemSize=n,e.count=o}},Be=class extends Ot{constructor(){super(),this._forcedType=we}},Pi=class extends Ot{constructor(){super(),this._forcedType=Te}},_e=class extends Ot{constructor(){super(),this._forcedType=ve}};var Mi=class{constructor(){this.index=new Be,this.position=new _e,this.bvhBounds=new Ii,this.bvhContents=new Ii,this._cachedIndexAttr=null,this.index.overrideItemSize=3}updateFrom(e){let{geometry:t}=e;if(fs(e,this.bvhBounds,this.bvhContents),this.position.updateFrom(t.attributes.position),e.indirect){let n=e._indirectBuffer;if(this._cachedIndexAttr===null||this._cachedIndexAttr.count!==n.length)if(t.index)this._cachedIndexAttr=t.index.clone();else{let o=Fe(De(t));this._cachedIndexAttr=new as(o,1,!1)}ls(t,n,this._cachedIndexAttr),this.index.updateFrom(this._cachedIndexAttr)}else this.index.updateFrom(t.index)}dispose(){let{index:e,position:t,bvhBounds:n,bvhContents:o}=this;e&&e.dispose(),t&&t.dispose(),n&&n.dispose(),o&&o.dispose()}};function ls(i,e,t){let n=t.array,o=i.index?i.index.array:null;for(let r=0,s=e.length;r<s;r++){let a=3*r,c=3*e[r];for(let p=0;p<3;p++)n[a+p]=o?o[c+p]:c+p}}function fs(i,e,t){let n=i._roots;if(n.length!==1)throw new Error("MeshBVHUniformStruct: Multi-root BVHs not supported.");let o=n[0],r=new Uint16Array(o),s=new Uint32Array(o),a=new Float32Array(o),c=o.byteLength/32,p=2*Math.ceil(Math.sqrt(c/2)),f=new Float32Array(4*p*p),u=Math.ceil(Math.sqrt(c)),l=new Uint32Array(2*u*u);for(let d=0;d<c;d++){let b=d*32/4,g=b*2,x=b;for(let h=0;h<3;h++)f[8*d+0+h]=a[x+0+h],f[8*d+4+h]=a[x+3+h];if(L(g,r)){let h=R(g,r),m=z(b,s),y=4294901760|h;l[d*2+0]=y,l[d*2+1]=m}else{let h=4*k(b,s)/32,m=ut(b,s);l[d*2+0]=m,l[d*2+1]=h}}e.image.data=f,e.image.width=p,e.image.height=p,e.format=rs,e.type=os,e.internalFormat="RGBA32F",e.minFilter=Se,e.magFilter=Se,e.generateMipmaps=!1,e.needsUpdate=!0,e.dispose(),t.image.data=l,t.image.width=u,t.image.height=u,t.format=cs,t.type=ss,t.internalFormat="RG32UI",t.minFilter=Se,t.magFilter=Se,t.generateMipmaps=!1,t.needsUpdate=!0,t.dispose()}import{BufferAttribute as dn,BufferGeometry as Me,Vector3 as Wt,Vector4 as mn,Matrix4 as hn,Matrix3 as us}from"three";var rt=new Wt,ct=new Wt,at=new Wt,Ei=new mn,Pe=new Wt,fn=new Wt,Di=new mn,Fi=new mn,Ie=new hn,Ni=new hn;function Ht(i,e){if(!i&&!e)return;let t=i.count===e.count,n=i.normalized===e.normalized,o=i.array.constructor===e.array.constructor,r=i.itemSize===e.itemSize;if(!t||!n||!o||!r)throw new Error}function qt(i,e=null){let t=i.array.constructor,n=i.normalized,o=i.itemSize,r=e===null?i.count:e;return new dn(new t(o*r),o,n)}function zi(i,e,t=0){if(i.isInterleavedBufferAttribute){let n=i.itemSize;for(let o=0,r=i.count;o<r;o++){let s=o+t;e.setX(s,i.getX(o)),n>=2&&e.setY(s,i.getY(o)),n>=3&&e.setZ(s,i.getZ(o)),n>=4&&e.setW(s,i.getW(o))}}else{let n=e.array,o=n.constructor,r=n.BYTES_PER_ELEMENT*i.itemSize*t;new o(n.buffer,r,i.array.length).set(i.array)}}function ps(i,e,t){let n=i.elements,o=e.elements;for(let r=0,s=o.length;r<s;r++)n[r]+=o[r]*t}function Ci(i,e,t){let n=i.skeleton,o=i.geometry,r=n.bones,s=n.boneInverses;Di.fromBufferAttribute(o.attributes.skinIndex,e),Fi.fromBufferAttribute(o.attributes.skinWeight,e),Ie.elements.fill(0);for(let a=0;a<4;a++){let c=Fi.getComponent(a);if(c!==0){let p=Di.getComponent(a);Ni.multiplyMatrices(r[p].matrixWorld,s[p]),ps(Ie,Ni,c)}}return Ie.multiply(i.bindMatrix).premultiply(i.bindMatrixInverse),t.transformDirection(Ie),t}function un(i,e,t,n,o){Pe.set(0,0,0);for(let r=0,s=i.length;r<s;r++){let a=e[r],c=i[r];a!==0&&(fn.fromBufferAttribute(c,n),t?Pe.addScaledVector(fn,a):Pe.addScaledVector(fn.sub(o),a))}o.add(Pe)}function ds(i,e={useGroups:!1,updateIndex:!1,skipAttributes:[]},t=new Me){let n=i[0].index!==null,{useGroups:o=!1,updateIndex:r=!1,skipAttributes:s=[]}=e,a=new Set(Object.keys(i[0].attributes)),c={},p=0;t.clearGroups();for(let f=0;f<i.length;++f){let u=i[f],l=0;if(n!==(u.index!==null))throw new Error("StaticGeometryGenerator: All geometries must have compatible attributes; make sure index attribute exists among all geometries, or in none of them.");for(let d in u.attributes){if(!a.has(d))throw new Error('StaticGeometryGenerator: All geometries must have compatible attributes; make sure "'+d+'" attribute exists among all geometries, or in none of them.');c[d]===void 0&&(c[d]=[]),c[d].push(u.attributes[d]),l++}if(l!==a.size)throw new Error("StaticGeometryGenerator: Make sure all geometries have the same number of attributes.");if(o){let d;if(n)d=u.index.count;else if(u.attributes.position!==void 0)d=u.attributes.position.count;else throw new Error("StaticGeometryGenerator: The geometry must have either an index or a position attribute");t.addGroup(p,d,f),p+=d}}if(n){let f=!1;if(!t.index){let u=0;for(let l=0;l<i.length;++l)u+=i[l].index.count;t.setIndex(new dn(new Uint32Array(u),1,!1)),f=!0}if(r||f){let u=t.index,l=0,d=0;for(let b=0;b<i.length;++b){let g=i[b],x=g.index;if(s[b]!==!0)for(let h=0;h<x.count;++h)u.setX(l,x.getX(h)+d),l++;d+=g.attributes.position.count}}}for(let f in c){let u=c[f];if(!(f in t.attributes)){let b=0;for(let g in u)b+=u[g].count;t.setAttribute(f,qt(c[f][0],b))}let l=t.attributes[f],d=0;for(let b=0,g=u.length;b<g;b++){let x=u[b];s[b]!==!0&&zi(x,l,d),d+=x.count}}return t}function ms(i,e){if(i===null||e===null)return i===e;if(i.length!==e.length)return!1;for(let t=0,n=i.length;t<n;t++)if(i[t]!==e[t])return!1;return!0}function hs(i){let{index:e,attributes:t}=i;if(e)for(let n=0,o=e.count;n<o;n+=3){let r=e.getX(n),s=e.getX(n+2);e.setX(n,s),e.setX(n+2,r)}else for(let n in t){let o=t[n],r=o.itemSize;for(let s=0,a=o.count;s<a;s+=3)for(let c=0;c<r;c++){let p=o.getComponent(s,c),f=o.getComponent(s+2,c);o.setComponent(s,c,f),o.setComponent(s+2,c,p)}}return i}var pn=class{constructor(e){this.matrixWorld=new hn,this.geometryHash=null,this.boneMatrices=null,this.primitiveCount=-1,this.mesh=e,this.update()}update(){let e=this.mesh,t=e.geometry,n=e.skeleton,o=(t.index?t.index.count:t.attributes.position.count)/3;if(this.matrixWorld.copy(e.matrixWorld),this.geometryHash=t.attributes.position.version,this.primitiveCount=o,n){n.boneTexture||n.computeBoneTexture(),n.update();let r=n.boneMatrices;!this.boneMatrices||this.boneMatrices.length!==r.length?this.boneMatrices=r.slice():this.boneMatrices.set(r)}else this.boneMatrices=null}didChange(){let e=this.mesh,t=e.geometry,n=(t.index?t.index.count:t.attributes.position.count)/3;return!(this.matrixWorld.equals(e.matrixWorld)&&this.geometryHash===t.attributes.position.version&&ms(e.skeleton&&e.skeleton.boneMatrices||null,this.boneMatrices)&&this.primitiveCount===n)}},Li=class{constructor(e){Array.isArray(e)||(e=[e]);let t=[];e.forEach(n=>{n.traverseVisible(o=>{o.isMesh&&t.push(o)})}),this.meshes=t,this.useGroups=!0,this.applyWorldTransforms=!0,this.attributes=["position","normal","color","tangent","uv","uv2"],this._intermediateGeometry=new Array(t.length).fill().map(()=>new Me),this._diffMap=new WeakMap}getMaterials(){let e=[];return this.meshes.forEach(t=>{Array.isArray(t.material)?e.push(...t.material):e.push(t.material)}),e}generate(e=new Me){let t=[],{meshes:n,useGroups:o,_intermediateGeometry:r,_diffMap:s}=this;for(let a=0,c=n.length;a<c;a++){let p=n[a],f=r[a],u=s.get(p);!u||u.didChange(p)?(this._convertToStaticGeometry(p,f),t.push(!1),u?u.update():s.set(p,new pn(p))):t.push(!0)}if(r.length===0){e.setIndex(null);let a=e.attributes;for(let c in a)e.deleteAttribute(c);for(let c in this.attributes)e.setAttribute(this.attributes[c],new dn(new Float32Array(0),4,!1))}else ds(r,{useGroups:o,skipAttributes:t},e);for(let a in e.attributes)e.attributes[a].needsUpdate=!0;return e}_convertToStaticGeometry(e,t=new Me){let n=e.geometry,o=this.applyWorldTransforms,r=this.attributes.includes("normal"),s=this.attributes.includes("tangent"),a=n.attributes,c=t.attributes;!t.index&&n.index&&(t.index=n.index.clone()),c.position||t.setAttribute("position",qt(a.position)),r&&!c.normal&&a.normal&&t.setAttribute("normal",qt(a.normal)),s&&!c.tangent&&a.tangent&&t.setAttribute("tangent",qt(a.tangent)),Ht(n.index,t.index),Ht(a.position,c.position),r&&Ht(a.normal,c.normal),s&&Ht(a.tangent,c.tangent);let p=a.position,f=r?a.normal:null,u=s?a.tangent:null,l=n.morphAttributes.position,d=n.morphAttributes.normal,b=n.morphAttributes.tangent,g=n.morphTargetsRelative,x=e.morphTargetInfluences,h=new us;h.getNormalMatrix(e.matrixWorld),n.index&&t.index.array.set(n.index.array);for(let m=0,y=a.position.count;m<y;m++)rt.fromBufferAttribute(p,m),f&&ct.fromBufferAttribute(f,m),u&&(Ei.fromBufferAttribute(u,m),at.fromBufferAttribute(u,m)),x&&(l&&un(l,x,g,m,rt),d&&un(d,x,g,m,ct),b&&un(b,x,g,m,at)),e.isSkinnedMesh&&(e.applyBoneTransform(m,rt),f&&Ci(e,m,ct),u&&Ci(e,m,at)),o&&rt.applyMatrix4(e.matrixWorld),c.position.setXYZ(m,rt.x,rt.y,rt.z),f&&(o&&ct.applyNormalMatrix(h),c.normal.setXYZ(m,ct.x,ct.y,ct.z)),u&&(o&&at.transformDirection(e.matrixWorld),c.tangent.setXYZW(m,at.x,at.y,at.z,Ei.w));for(let m in this.attributes){let y=this.attributes[m];y==="position"||y==="tangent"||y==="normal"||!(y in a)||(c[y]||t.setAttribute(y,qt(a[y])),Ht(a[y],c[y]),zi(a[y],c[y]))}return e.matrixWorld.determinant()<0&&hs(t),t}};var An={};Ui(An,{bvh_distance_functions:()=>yn,bvh_ray_functions:()=>bn,bvh_struct_definitions:()=>gn,common_functions:()=>xn});var xn=`

// A stack of uint32 indices can can store the indices for
// a perfectly balanced tree with a depth up to 31. Lower stack
// depth gets higher performance.
//
// However not all trees are balanced. Best value to set this to
// is the trees max depth.
#ifndef BVH_STACK_DEPTH
#define BVH_STACK_DEPTH 60
#endif

#ifndef INFINITY
#define INFINITY 1e20
#endif

// Utilities
uvec4 uTexelFetch1D( usampler2D tex, uint index ) {

	uint width = uint( textureSize( tex, 0 ).x );
	uvec2 uv;
	uv.x = index % width;
	uv.y = index / width;

	return texelFetch( tex, ivec2( uv ), 0 );

}

ivec4 iTexelFetch1D( isampler2D tex, uint index ) {

	uint width = uint( textureSize( tex, 0 ).x );
	uvec2 uv;
	uv.x = index % width;
	uv.y = index / width;

	return texelFetch( tex, ivec2( uv ), 0 );

}

vec4 texelFetch1D( sampler2D tex, uint index ) {

	uint width = uint( textureSize( tex, 0 ).x );
	uvec2 uv;
	uv.x = index % width;
	uv.y = index / width;

	return texelFetch( tex, ivec2( uv ), 0 );

}

vec4 textureSampleBarycoord( sampler2D tex, vec3 barycoord, uvec3 faceIndices ) {

	return
		barycoord.x * texelFetch1D( tex, faceIndices.x ) +
		barycoord.y * texelFetch1D( tex, faceIndices.y ) +
		barycoord.z * texelFetch1D( tex, faceIndices.z );

}

void ndcToCameraRay(
	vec2 coord, mat4 cameraWorld, mat4 invProjectionMatrix,
	out vec3 rayOrigin, out vec3 rayDirection
) {

	// get camera look direction and near plane for camera clipping
	vec4 lookDirection = cameraWorld * vec4( 0.0, 0.0, - 1.0, 0.0 );
	vec4 nearVector = invProjectionMatrix * vec4( 0.0, 0.0, - 1.0, 1.0 );
	float near = abs( nearVector.z / nearVector.w );

	// get the camera direction and position from camera matrices
	vec4 origin = cameraWorld * vec4( 0.0, 0.0, 0.0, 1.0 );
	vec4 direction = invProjectionMatrix * vec4( coord, 0.5, 1.0 );
	direction /= direction.w;
	direction = cameraWorld * direction - origin;

	// slide the origin along the ray until it sits at the near clip plane position
	origin.xyz += direction.xyz * near / dot( direction, lookDirection );

	rayOrigin = origin.xyz;
	rayDirection = direction.xyz;

}
`;var yn=`

float dot2( vec3 v ) {

	return dot( v, v );

}

// https://www.shadertoy.com/view/ttfGWl
vec3 closestPointToTriangle( vec3 p, vec3 v0, vec3 v1, vec3 v2, out vec3 barycoord ) {

    vec3 v10 = v1 - v0;
    vec3 v21 = v2 - v1;
    vec3 v02 = v0 - v2;

	vec3 p0 = p - v0;
	vec3 p1 = p - v1;
	vec3 p2 = p - v2;

    vec3 nor = cross( v10, v02 );

    // method 2, in barycentric space
    vec3  q = cross( nor, p0 );
    float d = 1.0 / dot2( nor );
    float u = d * dot( q, v02 );
    float v = d * dot( q, v10 );
    float w = 1.0 - u - v;

	if( u < 0.0 ) {

		w = clamp( dot( p2, v02 ) / dot2( v02 ), 0.0, 1.0 );
		u = 0.0;
		v = 1.0 - w;

	} else if( v < 0.0 ) {

		u = clamp( dot( p0, v10 ) / dot2( v10 ), 0.0, 1.0 );
		v = 0.0;
		w = 1.0 - u;

	} else if( w < 0.0 ) {

		v = clamp( dot( p1, v21 ) / dot2( v21 ), 0.0, 1.0 );
		w = 0.0;
		u = 1.0-v;

	}

	barycoord = vec3( u, v, w );
    return u * v1 + v * v2 + w * v0;

}

float distanceToTriangles(
	// geometry info and triangle range
	sampler2D positionAttr, usampler2D indexAttr, uint offset, uint count,

	// point and cut off range
	vec3 point, float closestDistanceSquared,

	// outputs
	inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord, inout float side, inout vec3 outPoint
) {

	bool found = false;
	vec3 localBarycoord;
	for ( uint i = offset, l = offset + count; i < l; i ++ ) {

		uvec3 indices = uTexelFetch1D( indexAttr, i ).xyz;
		vec3 a = texelFetch1D( positionAttr, indices.x ).rgb;
		vec3 b = texelFetch1D( positionAttr, indices.y ).rgb;
		vec3 c = texelFetch1D( positionAttr, indices.z ).rgb;

		// get the closest point and barycoord
		vec3 closestPoint = closestPointToTriangle( point, a, b, c, localBarycoord );
		vec3 delta = point - closestPoint;
		float sqDist = dot2( delta );
		if ( sqDist < closestDistanceSquared ) {

			// set the output results
			closestDistanceSquared = sqDist;
			faceIndices = uvec4( indices.xyz, i );
			faceNormal = normalize( cross( a - b, b - c ) );
			barycoord = localBarycoord;
			outPoint = closestPoint;
			side = sign( dot( faceNormal, delta ) );

		}

	}

	return closestDistanceSquared;

}

float distanceSqToBounds( vec3 point, vec3 boundsMin, vec3 boundsMax ) {

	vec3 clampedPoint = clamp( point, boundsMin, boundsMax );
	vec3 delta = point - clampedPoint;
	return dot( delta, delta );

}

float distanceSqToBVHNodeBoundsPoint( vec3 point, sampler2D bvhBounds, uint currNodeIndex ) {

	uint cni2 = currNodeIndex * 2u;
	vec3 boundsMin = texelFetch1D( bvhBounds, cni2 ).xyz;
	vec3 boundsMax = texelFetch1D( bvhBounds, cni2 + 1u ).xyz;
	return distanceSqToBounds( point, boundsMin, boundsMax );

}

// use a macro to hide the fact that we need to expand the struct into separate fields
#define	bvhClosestPointToPoint(		bvh,		point, faceIndices, faceNormal, barycoord, side, outPoint	)	_bvhClosestPointToPoint(		bvh.position, bvh.index, bvh.bvhBounds, bvh.bvhContents,		point, faceIndices, faceNormal, barycoord, side, outPoint	)

float _bvhClosestPointToPoint(
	// bvh info
	sampler2D bvh_position, usampler2D bvh_index, sampler2D bvh_bvhBounds, usampler2D bvh_bvhContents,

	// point to check
	vec3 point,

	// output variables
	inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord,
	inout float side, inout vec3 outPoint
 ) {

	// stack needs to be twice as long as the deepest tree we expect because
	// we push both the left and right child onto the stack every traversal
	int ptr = 0;
	uint stack[ BVH_STACK_DEPTH ];
	stack[ 0 ] = 0u;

	float closestDistanceSquared = pow( 100000.0, 2.0 );
	bool found = false;
	while ( ptr > - 1 && ptr < BVH_STACK_DEPTH ) {

		uint currNodeIndex = stack[ ptr ];
		ptr --;

		// check if we intersect the current bounds
		float boundsHitDistance = distanceSqToBVHNodeBoundsPoint( point, bvh_bvhBounds, currNodeIndex );
		if ( boundsHitDistance > closestDistanceSquared ) {

			continue;

		}

		uvec2 boundsInfo = uTexelFetch1D( bvh_bvhContents, currNodeIndex ).xy;
		bool isLeaf = bool( boundsInfo.x & 0xffff0000u );
		if ( isLeaf ) {

			uint count = boundsInfo.x & 0x0000ffffu;
			uint offset = boundsInfo.y;
			closestDistanceSquared = distanceToTriangles(
				bvh_position, bvh_index, offset, count, point, closestDistanceSquared,

				// outputs
				faceIndices, faceNormal, barycoord, side, outPoint
			);

		} else {

			uint leftIndex = currNodeIndex + 1u;
			uint splitAxis = boundsInfo.x & 0x0000ffffu;
			uint rightIndex = boundsInfo.y;
			bool leftToRight = distanceSqToBVHNodeBoundsPoint( point, bvh_bvhBounds, leftIndex ) < distanceSqToBVHNodeBoundsPoint( point, bvh_bvhBounds, rightIndex );//rayDirection[ splitAxis ] >= 0.0;
			uint c1 = leftToRight ? leftIndex : rightIndex;
			uint c2 = leftToRight ? rightIndex : leftIndex;

			// set c2 in the stack so we traverse it later. We need to keep track of a pointer in
			// the stack while we traverse. The second pointer added is the one that will be
			// traversed first
			ptr ++;
			stack[ ptr ] = c2;
			ptr ++;
			stack[ ptr ] = c1;

		}

	}

	return sqrt( closestDistanceSquared );

}
`;var bn=`

#ifndef TRI_INTERSECT_EPSILON
#define TRI_INTERSECT_EPSILON 1e-5
#endif

// Raycasting
bool intersectsBounds( vec3 rayOrigin, vec3 rayDirection, vec3 boundsMin, vec3 boundsMax, out float dist ) {

	// https://www.reddit.com/r/opengl/comments/8ntzz5/fast_glsl_ray_box_intersection/
	// https://tavianator.com/2011/ray_box.html
	vec3 invDir = 1.0 / rayDirection;

	// find intersection distances for each plane
	vec3 tMinPlane = invDir * ( boundsMin - rayOrigin );
	vec3 tMaxPlane = invDir * ( boundsMax - rayOrigin );

	// get the min and max distances from each intersection
	vec3 tMinHit = min( tMaxPlane, tMinPlane );
	vec3 tMaxHit = max( tMaxPlane, tMinPlane );

	// get the furthest hit distance
	vec2 t = max( tMinHit.xx, tMinHit.yz );
	float t0 = max( t.x, t.y );

	// get the minimum hit distance
	t = min( tMaxHit.xx, tMaxHit.yz );
	float t1 = min( t.x, t.y );

	// set distance to 0.0 if the ray starts inside the box
	dist = max( t0, 0.0 );

	return t1 >= dist;

}

bool intersectsTriangle(
	vec3 rayOrigin, vec3 rayDirection, vec3 a, vec3 b, vec3 c,
	out vec3 barycoord, out vec3 norm, out float dist, out float side
) {

	// https://stackoverflow.com/questions/42740765/intersection-between-line-and-triangle-in-3d
	vec3 edge1 = b - a;
	vec3 edge2 = c - a;
	norm = cross( edge1, edge2 );

	float det = - dot( rayDirection, norm );
	float invdet = 1.0 / det;

	vec3 AO = rayOrigin - a;
	vec3 DAO = cross( AO, rayDirection );

	vec4 uvt;
	uvt.x = dot( edge2, DAO ) * invdet;
	uvt.y = - dot( edge1, DAO ) * invdet;
	uvt.z = dot( AO, norm ) * invdet;
	uvt.w = 1.0 - uvt.x - uvt.y;

	// set the hit information
	barycoord = uvt.wxy; // arranged in A, B, C order
	dist = uvt.z;
	side = sign( det );
	norm = side * normalize( norm );

	// add an epsilon to avoid misses between triangles
	uvt += vec4( TRI_INTERSECT_EPSILON );

	return all( greaterThanEqual( uvt, vec4( 0.0 ) ) );

}

bool intersectTriangles(
	// geometry info and triangle range
	sampler2D positionAttr, usampler2D indexAttr, uint offset, uint count,

	// ray
	vec3 rayOrigin, vec3 rayDirection,

	// outputs
	inout float minDistance, inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord,
	inout float side, inout float dist
) {

	bool found = false;
	vec3 localBarycoord, localNormal;
	float localDist, localSide;
	for ( uint i = offset, l = offset + count; i < l; i ++ ) {

		uvec3 indices = uTexelFetch1D( indexAttr, i ).xyz;
		vec3 a = texelFetch1D( positionAttr, indices.x ).rgb;
		vec3 b = texelFetch1D( positionAttr, indices.y ).rgb;
		vec3 c = texelFetch1D( positionAttr, indices.z ).rgb;

		if (
			intersectsTriangle( rayOrigin, rayDirection, a, b, c, localBarycoord, localNormal, localDist, localSide )
			&& localDist < minDistance
		) {

			found = true;
			minDistance = localDist;

			faceIndices = uvec4( indices.xyz, i );
			faceNormal = localNormal;

			side = localSide;
			barycoord = localBarycoord;
			dist = localDist;

		}

	}

	return found;

}

bool intersectsBVHNodeBounds( vec3 rayOrigin, vec3 rayDirection, sampler2D bvhBounds, uint currNodeIndex, out float dist ) {

	uint cni2 = currNodeIndex * 2u;
	vec3 boundsMin = texelFetch1D( bvhBounds, cni2 ).xyz;
	vec3 boundsMax = texelFetch1D( bvhBounds, cni2 + 1u ).xyz;
	return intersectsBounds( rayOrigin, rayDirection, boundsMin, boundsMax, dist );

}

// use a macro to hide the fact that we need to expand the struct into separate fields
#define	bvhIntersectFirstHit(		bvh,		rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist	)	_bvhIntersectFirstHit(		bvh.position, bvh.index, bvh.bvhBounds, bvh.bvhContents,		rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist	)

bool _bvhIntersectFirstHit(
	// bvh info
	sampler2D bvh_position, usampler2D bvh_index, sampler2D bvh_bvhBounds, usampler2D bvh_bvhContents,

	// ray
	vec3 rayOrigin, vec3 rayDirection,

	// output variables split into separate variables due to output precision
	inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord,
	inout float side, inout float dist
) {

	// stack needs to be twice as long as the deepest tree we expect because
	// we push both the left and right child onto the stack every traversal
	int ptr = 0;
	uint stack[ BVH_STACK_DEPTH ];
	stack[ 0 ] = 0u;

	float triangleDistance = INFINITY;
	bool found = false;
	while ( ptr > - 1 && ptr < BVH_STACK_DEPTH ) {

		uint currNodeIndex = stack[ ptr ];
		ptr --;

		// check if we intersect the current bounds
		float boundsHitDistance;
		if (
			! intersectsBVHNodeBounds( rayOrigin, rayDirection, bvh_bvhBounds, currNodeIndex, boundsHitDistance )
			|| boundsHitDistance > triangleDistance
		) {

			continue;

		}

		uvec2 boundsInfo = uTexelFetch1D( bvh_bvhContents, currNodeIndex ).xy;
		bool isLeaf = bool( boundsInfo.x & 0xffff0000u );

		if ( isLeaf ) {

			uint count = boundsInfo.x & 0x0000ffffu;
			uint offset = boundsInfo.y;

			found = intersectTriangles(
				bvh_position, bvh_index, offset, count,
				rayOrigin, rayDirection, triangleDistance,
				faceIndices, faceNormal, barycoord, side, dist
			) || found;

		} else {

			uint leftIndex = currNodeIndex + 1u;
			uint splitAxis = boundsInfo.x & 0x0000ffffu;
			uint rightIndex = boundsInfo.y;

			bool leftToRight = rayDirection[ splitAxis ] >= 0.0;
			uint c1 = leftToRight ? leftIndex : rightIndex;
			uint c2 = leftToRight ? rightIndex : leftIndex;

			// set c2 in the stack so we traverse it later. We need to keep track of a pointer in
			// the stack while we traverse. The second pointer added is the one that will be
			// traversed first
			ptr ++;
			stack[ ptr ] = c2;

			ptr ++;
			stack[ ptr ] = c1;

		}

	}

	return found;

}
`;var gn=`
struct BVH {

	usampler2D index;
	sampler2D position;

	sampler2D bvhBounds;
	usampler2D bvhContents;

};
`;var Pa=gn,Ia=yn,Ma=`
	${xn}
	${bn}
`;export{vn as AVERAGE,An as BVHShaderGLSL,Xt as CENTER,Ee as CONTAINED,H as ExtendedTriangle,_e as FloatVertexAttributeTexture,ki as INTERSECTED,Pi as IntVertexAttributeTexture,st as MeshBVH,sn as MeshBVHHelper,Mi as MeshBVHUniformStruct,Vi as NOT_INTERSECTED,U as OrientedBox,Tn as SAH,Li as StaticGeometryGenerator,Be as UIntVertexAttributeTexture,Ot as VertexAttributeTexture,Xo as acceleratedRaycast,Go as computeBoundsTree,Yo as disposeBoundsTree,Uo as estimateMemoryInBytes,Ro as getBVHExtremes,ko as getJSONStructure,co as getTriangleHitPointInfo,Ia as shaderDistanceFunction,Ma as shaderIntersectFunction,Pa as shaderStructs,Vo as validateBounds};
