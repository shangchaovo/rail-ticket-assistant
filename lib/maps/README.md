# 全国地理背景与离线站点位置

网页地图使用本地矢量背景和站点索引。打开地图、切换班次、全国/当前路线、拖动和缩放均不请求公共地图瓦片、Photon、Overpass 或 BRouter。余票、经停和时刻仍来自用户的正常 12306 会话。

## 站点位置

`station-atlas.json` 是按当前官方站码和站名匹配的 OSM 位置索引。2026-10-06 构建版本匹配 3,163 个站点，151 个存在异地同名歧义的站点保留为未知；没有匹配的数据也保持未知。

来源：[HOT / HDX China Railways OpenStreetMap Export](https://data.humdata.org/dataset/hotosm_chn_railways)，OSM 快照 2026-05-10，导出日期 2026-05-12，下载日期 2026-10-06。坐标为 WGS84。数据中的 OSM 节点使用原始位置；站房多边形使用其包围盒中心，供车站位置概览，不用于出入口定位或精确导航。

© OpenStreetMap contributors。数据库及衍生数据库按 [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 提供；[OpenStreetMap attribution](https://www.openstreetmap.org/copyright)。网页附有署名和来源链接。归一化的数据库副本可从 `/maps/station-atlas.json` 下载；不含用户行程、会话或余票。

重建方式：`python3 scripts/build-national-atlas.py path/to/hotosm_chn_railways_osm_geojson.zip`。脚本流式读取全国导出，避免把完整轨道文件载入内存。也接受 Overpass JSON。官方站名精确匹配（去除“站”“火车站”后缀），异地候选超过 2.5 km 则不选择。已提供标签中的地铁、轻轨、非列车站点会排除。位置缺失时不跨过未知站点画连续连线。

## 全国背景

`regional-basemap.json` 是 Natural Earth **Admin 1 – States and Provinces** 5.1.1 的简化数据，含大陆各省区市与台港澳区域。`national-background.json` 由它生成，为全国地图提供轻量 SVG 地理背景。

[原始数据](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_10m_admin_1_states_provinces.geojson)于 2026-10-05 取得。许可为[公共领域 CC0](https://www.naturalearthdata.com/about/terms-of-use/)。WGS84 坐标，经度/纬度投影一致。该背景用于位置概览，不是官方标准地图或导航数据。

全国视图包含西部、东北、海南、台湾、香港、澳门与南海地理范围；当前路线视图根据所选经停坐标缩放。主图连线表示 12306 经停顺序，不能声称是实际轨道或列车实时位置。颜色严格沿用实际票段：蓝色覆盖、橙色未覆盖、紫色多买、灰色本次乘车区间外。
