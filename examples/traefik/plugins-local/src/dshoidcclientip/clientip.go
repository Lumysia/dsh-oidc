// Package dshoidcclientip is a Traefik middleware plugin that sets
// X-Dsh-Oidc-Client-Ip from the address of the TCP peer, replacing any value
// the client sent. Traefik's own middlewares cannot set a header from the
// connection, and dsh-oidc's /auth/login needs this header.
package dshoidcclientip

import (
	"context"
	"net"
	"net/http"
)

const clientIPHeader = "X-Dsh-Oidc-Client-Ip"

// Config is empty: the plugin has no options.
type Config struct{}

// CreateConfig returns the plugin configuration.
func CreateConfig() *Config {
	return &Config{}
}

type clientIP struct {
	next http.Handler
}

// New creates the middleware.
func New(_ context.Context, next http.Handler, _ *Config, _ string) (http.Handler, error) {
	return &clientIP{next: next}, nil
}

func (c *clientIP) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	req.Header.Del(clientIPHeader)
	if host, _, err := net.SplitHostPort(req.RemoteAddr); err == nil {
		req.Header.Set(clientIPHeader, host)
	}
	c.next.ServeHTTP(rw, req)
}
