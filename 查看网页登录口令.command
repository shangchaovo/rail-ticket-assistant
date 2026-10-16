#!/bin/zsh
set -e
print '网页登录口令仅供本人使用：'
/usr/bin/security find-generic-password -a rail-assistant -s cn.rail-assistant.webPassword -w
print '\n按回车关闭。'
read
