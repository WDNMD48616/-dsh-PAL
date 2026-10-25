window.__ModuleLoader__.load({
  id: '@local/pal-dsh-pet',
  factory() {
    return {
      inject: ['slots'],
      apply(ctx) {
        // The pet is one native topmost window owned by the Host plugin.
        // Keep the page slot empty so there can never be a second page Pal.
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            { name: 'shell.overlay', id: 'pal-dsh-pet', order: -10 },
            function () { return null; }
          );
        });
      }
    };
  }
});
