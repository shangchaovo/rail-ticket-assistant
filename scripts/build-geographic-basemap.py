"""Reduce the public-domain Natural Earth admin-1 GeoJSON to a small WGS84 basemap.
Usage: python3 scripts/build-geographic-basemap.py SOURCE_GEOJSON
Original: nvkelso/natural-earth-vector, ne_10m_admin_1_states_provinces, v5.1.1.
This is a regional reference background, not a street or navigation map.
"""
import json, pathlib, sys

def simplify_ring(points, tolerance=.006):
    # Iterative Douglas-Peucker, retaining closed rings and their endpoints.
    keep={0,len(points)-1}; stack=[(0,len(points)-1)]
    while stack:
        start,end=stack.pop(); a,b=points[start],points[end]
        dx,dy=b[0]-a[0],b[1]-a[1]; length=dx*dx+dy*dy
        best=0; furthest=-1
        for i in range(start+1,end):
            p=points[i]; t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)) if length else 0
            distance=(p[0]-a[0]-t*dx)**2+(p[1]-a[1]-t*dy)**2
            if distance>best: best=distance; furthest=i
        if best>tolerance*tolerance and furthest>=0:
            keep.add(furthest); stack.extend([(start,furthest),(furthest,end)])
    result=[[round(v,5) for v in points[i][:2]] for i in sorted(keep)]
    return result if len(result)>=4 else None

def polygon(rings):
    result=[simplify_ring(ring) for ring in rings]
    return [ring for ring in result if ring] if result and result[0] else None

source=json.loads(pathlib.Path(sys.argv[1]).read_text())
features=[]
for f in source['features']:
    p=f['properties']
    if p.get('iso_a2') not in ('CN','TW','HK','MO'): continue
    g=f['geometry']; poly=polygon(g['coordinates']) if g['type']=='Polygon' else None
    multi=[polygon(rings) for rings in g['coordinates']] if g['type']=='MultiPolygon' else None
    if multi is not None: multi=[rings for rings in multi if rings]
    coordinates=poly if g['type']=='Polygon' else multi
    if not coordinates: continue
    features.append({'type':'Feature','properties':{'name':p.get('name_zh') or p['name'], 'center':[p['longitude'],p['latitude']]},'geometry':{'type':g['type'],'coordinates':coordinates}})
output=pathlib.Path(__file__).resolve().parents[1]/'lib/maps/regional-basemap.json'
output.write_text(json.dumps({'type':'FeatureCollection','features':features},ensure_ascii=False,separators=(',',':')))
print(json.dumps({'features':len(features),'bytes':output.stat().st_size}))
