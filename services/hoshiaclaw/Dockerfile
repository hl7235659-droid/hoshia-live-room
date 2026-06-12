FROM golang:1.22-alpine AS test
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN go test ./...

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN go build -o /out/hoshiaclaw ./cmd/hoshiaclaw

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/hoshiaclaw /app/hoshiaclaw
EXPOSE 8080
CMD ["/app/hoshiaclaw"]
