"""Build offline WGS84 station positions and a compact national SVG background.

Usage: python3 scripts/build-national-atlas.py path/to/hotosm_chn_railways_osm_geojson.zip
Input is an OSM/HOT export (or Overpass JSON), never a runtime ticket query.
"""
import datetime
import json
import math
import pathlib
import sys
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
input_path = pathlib.Path(sys.argv[1])
source_url = 'https://data.humdata.org/dataset/hotosm_chn_railways'
if input_path.suffix == '.zip':
    # Each feature occupies one line in the HOT export: skip rail-track geometry
    # without loading the 300 MB national railway file into memory.
    elements = []
    with zipfile.ZipFile(input_path) as archive:
        readme = archive.read('README.txt').decode()
        snapshot = next(line.split(':',1)[1].strip() for line in readme.splitlines() if line.startswith('Snapshot:'))
        with archive.open('railways.geojson') as file:
            for raw in file:
                if b'"railway": "station"' not in raw:
                    continue
                feature = json.loads(raw.decode().strip().rstrip(','))
                tags,geo = feature['properties'],feature['geometry']
                if geo['type'] == 'Point':
                    lon,lat = geo['coordinates'][:2]
                elif geo['type'] in ('Polygon','MultiPolygon'):
                    polygons = [geo['coordinates']] if geo['type']=='Polygon' else geo['coordinates']
                    outer = [point for polygon in polygons for point in polygon[0]]
                    lon = (min(p[0] for p in outer)+max(p[0] for p in outer))/2
                    lat = (min(p[1] for p in outer)+max(p[1] for p in outer))/2
                else:
                    continue
                kind,identifier = tags['id'].split('/')
                elements.append({'type':kind,'id':int(identifier),'lon':lon,'lat':lat,'tags':{'name':tags.get('name'),'name:zh':tags.get('name_zh'),'railway':'station'}})
    source = {'elements':elements,'osm3s':{'timestamp_osm_base':snapshot}}
else:
    source = json.loads(input_path.read_text())
    source_url = 'https://www.openstreetmap.org/'
if source.get('remark') or not source.get('elements'):
    raise ValueError('Incomplete OSM export; no atlas was written')

def normalize(name):
    name = str(name or '').strip().replace(' ', '')
    for suffix in ('火车站', '站'):
        if name.endswith(suffix):
            return name[:-len(suffix)]
    return name

def distance(a, b):
    rad = math.pi / 180
    h = math.sin((a[1]-b[1])*rad/2)**2 + math.cos(a[1]*rad)*math.cos(b[1]*rad)*math.sin((a[0]-b[0])*rad/2)**2
    return 12742017.6 * math.asin(min(1, math.sqrt(h)))

index = {}
for element in source['elements']:
    tags = element.get('tags', {})
    if tags.get('railway') != 'station' and tags.get('building') != 'train_station':
        continue
    if tags.get('subway') == 'yes' or tags.get('light_rail') == 'yes' or tags.get('station') in ('subway','light_rail','tram','monorail') or tags.get('train') == 'no':
        continue
    if any('地铁' in str(tags.get(k,'')) or 'Metro' in str(tags.get(k,'')) for k in ('operator','network')):
        continue
    center = element.get('center', {})
    lon, lat = element.get('lon',center.get('lon')), element.get('lat',center.get('lat'))
    if not isinstance(lon,(int,float)) or not isinstance(lat,(int,float)) or not (73 <= lon <= 136 and 18 <= lat <= 54):
        continue
    item = [round(lon,6),round(lat,6),element['type'][0],element['id']]
    priority = (0 if tags.get('station') == 'train' or tags.get('train') == 'yes' else 1, 0 if element['type'] == 'node' else 1)
    for key in ('name','name:zh','name:zh-Hans','official_name','short_name','alt_name'):
        for name in str(tags.get(key) or '').split(';'):
            name = normalize(name)
            if name:
                index.setdefault(name, []).append((priority,item))

stations, ambiguous = {}, {}
for station in json.loads((root/'lib/stations.json').read_text()):
    items = sorted(index.get(normalize(station['name']), []))
    if not items:
        continue
    chosen = items[0][1]
    if any(distance(chosen[:2], item[:2]) > 2500 for _,item in items):
        ambiguous[station['code']] = station['name']
        continue
    stations[station['code']] = [station['name'], *chosen]

now = datetime.datetime.now(datetime.timezone.utc).isoformat()
atlas = {'source':'OpenStreetMap / HOT','sourceUrl':source_url,'license':'ODbL-1.0','coordinateSystem':'WGS84','collectedAt':now,'dataTime':source.get('osm3s',{}).get('timestamp_osm_base'),'stations':stations,'ambiguous':ambiguous}
encoded_atlas = json.dumps(atlas,ensure_ascii=False,separators=(',',':'))
(root/'lib/maps/station-atlas.json').write_text(encoded_atlas)
(root/'public/maps').mkdir(exist_ok=True)
(root/'public/maps/station-atlas.json').write_text(encoded_atlas)

def project(p):
    return [(p[0]-72)*16, (math.log(math.tan(math.pi/4+55*math.pi/360))-math.log(math.tan(math.pi/4+p[1]*math.pi/360)))*16*180/math.pi]

def simplify(points, tolerance=.025):
    keep = {0,len(points)-1}
    stack = [(0,len(points)-1)]
    while stack:
        start,end = stack.pop(); a,b = points[start],points[end]
        dx,dy = b[0]-a[0],b[1]-a[1]; length = dx*dx+dy*dy
        best,furthest = 0,-1
        for i in range(start+1,end):
            p = points[i]; t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)) if length else 0
            d=(p[0]-a[0]-t*dx)**2+(p[1]-a[1]-t*dy)**2
            if d>best: best,furthest = d,i
        if best>tolerance*tolerance:
            keep.add(furthest);stack.extend([(start,furthest),(furthest,end)])
    return [project(points[i]) for i in sorted(keep)]

background = json.loads((root/'lib/maps/regional-basemap.json').read_text())
regions,labels = [],[]
for feature in background['features']:
    prop,geo = feature['properties'],feature['geometry']
    polygons = [geo['coordinates']] if geo['type']=='Polygon' else geo['coordinates']
    rings = [simplify(ring) for polygon in polygons for ring in polygon]
    rings = [ring for ring in rings if len(ring)>=4]
    path = ''.join('M'+'L'.join(f'{x:.2f},{y:.2f}' for x,y in ring)+'Z' for ring in rings)
    regions.append({'name':prop['name'],'path':path})
    if prop['name'].endswith(('省','自治区','市')) and not (119<prop['center'][0]<123 and 21<prop['center'][1]<26):
        labels.append({'name':prop['name'].replace('维吾尔自治区','').replace('壮族自治区','').replace('回族自治区','').replace('自治区','').replace('省','').replace('市',''),'point':project(prop['center'])})
labels.extend({'name':name,'point':project(p)} for name,p in [('台湾',[121,23.7]),('香港',[114.18,22.32]),('澳门',[113.55,22.17]),('南海',[115,13]),('东海',[125,28]),('渤海',[120,39])])
national = {'source':'Natural Earth 5.1.1','coordinateSystem':'WGS84','regions':regions,'labels':labels}
(root/'lib/maps/national-background.json').write_text(json.dumps(national,ensure_ascii=False,separators=(',',':')))
print(json.dumps({'locatedStations':len(stations),'ambiguousStations':len(ambiguous),'regions':len(regions),'atlasBytes':(root/'lib/maps/station-atlas.json').stat().st_size,'backgroundBytes':(root/'lib/maps/national-background.json').stat().st_size},ensure_ascii=False))
