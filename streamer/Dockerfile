FROM alpine:3.19
RUN apk add --no-cache ffmpeg
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
